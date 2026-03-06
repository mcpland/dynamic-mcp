import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { AuditLogger } from '../audit/logger.js';
import type { ToolExecutionGuard } from '../security/guard.js';
import { serviceVersion } from '../version.js';

const UpstreamAliasSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9._:-]{2,63}$/);

const AdminTokenSchema = {
  adminToken: z.string().optional()
};

const UpstreamAttachInputSchema = {
  ...AdminTokenSchema,
  alias: UpstreamAliasSchema.describe('Local alias used to reference the attached upstream MCP'),
  transport: z.enum(['stdio', 'http']),
  command: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe('Required when transport=stdio'),
  args: z
    .array(z.string().max(2000))
    .max(64)
    .default([])
    .describe('Stdio process arguments (transport=stdio)'),
  env: z
    .record(z.string(), z.string())
    .default({})
    .describe('Optional stdio process environment overrides (transport=stdio)'),
  cwd: z.string().min(1).max(2000).optional().describe('Optional working directory (transport=stdio)'),
  url: z.string().url().optional().describe('Required when transport=http'),
  headers: z
    .record(z.string(), z.string())
    .default({})
    .describe('Optional HTTP headers (transport=http)'),
  replace: z.boolean().default(false).describe('Replace an existing alias when true')
};

const UpstreamAttachOutputSchema = z.object({
  alias: z.string(),
  transport: z.enum(['stdio', 'http']),
  target: z.string(),
  toolCount: z.number().int().nonnegative(),
  toolNames: z.array(z.string()),
  attachedAt: z.string()
});

const UpstreamDetachInputSchema = {
  ...AdminTokenSchema,
  alias: UpstreamAliasSchema
};

const UpstreamDetachOutputSchema = z.object({
  alias: z.string(),
  detached: z.boolean()
});

type UpstreamTransportMode = 'stdio' | 'http';

type AttachedUpstream =
  | {
      client: Client;
      transportMode: 'stdio';
      target: string;
      attachedAt: string;
      transportHandle: StdioClientTransport;
    }
  | {
      client: Client;
      transportMode: 'http';
      target: string;
      attachedAt: string;
      transportHandle: StreamableHTTPClientTransport;
    };

const textItem = (text: string) => ({ type: 'text' as const, text });

export interface UpstreamMcpAttachServiceOptions {
  server: McpServer;
  executionGuard: ToolExecutionGuard;
  auditLogger?: AuditLogger;
  adminToken?: string;
  maxAttached?: number;
}

export class UpstreamMcpAttachService {
  private readonly server: McpServer;
  private readonly executionGuard: ToolExecutionGuard;
  private readonly auditLogger?: AuditLogger;
  private readonly adminToken?: string;
  private readonly maxAttached: number;
  private readonly attached = new Map<string, AttachedUpstream>();
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: UpstreamMcpAttachServiceOptions) {
    this.server = options.server;
    this.executionGuard = options.executionGuard;
    this.auditLogger = options.auditLogger;
    this.adminToken = options.adminToken;
    this.maxAttached = options.maxAttached ?? 8;
  }

  initialize(): void {
    this.server.registerTool(
      'upstream.mcp.attach',
      {
        title: 'Attach Upstream MCP',
        description:
          'Experimentally attach to an existing MCP server (stdio/http) and return its current tool list',
        inputSchema: UpstreamAttachInputSchema,
        outputSchema: UpstreamAttachOutputSchema
      },
      async (input) => {
        return this.guarded('upstream.mcp.attach', async () => {
          try {
            this.assertAdmin(input.adminToken);
            const output = await this.runMutation(() => this.attach(input));

            return {
              content: [textItem(JSON.stringify(output, null, 2))],
              structuredContent: output
            };
          } catch (error) {
            return toErrorResult(error);
          }
        });
      }
    );

    this.server.registerTool(
      'upstream.mcp.detach',
      {
        title: 'Detach Upstream MCP',
        description: 'Detach a previously attached upstream MCP alias and release resources',
        inputSchema: UpstreamDetachInputSchema,
        outputSchema: UpstreamDetachOutputSchema
      },
      async (input) => {
        return this.guarded('upstream.mcp.detach', async () => {
          try {
            this.assertAdmin(input.adminToken);
            const output = await this.runMutation(() => this.detach(input.alias));
            return {
              content: [textItem(JSON.stringify(output, null, 2))],
              structuredContent: output
            };
          } catch (error) {
            return toErrorResult(error);
          }
        });
      }
    );
  }

  async dispose(): Promise<void> {
    await this.runMutation(async () => {
      const entries = [...this.attached.values()];
      this.attached.clear();
      await Promise.all(entries.map((upstream) => this.closeAttached(upstream)));
    });
  }

  private async attach(input: {
    alias: string;
    transport: UpstreamTransportMode;
    command?: string;
    args: string[];
    env: Record<string, string>;
    cwd?: string;
    url?: string;
    headers: Record<string, string>;
    replace: boolean;
  }): Promise<z.infer<typeof UpstreamAttachOutputSchema>> {
    const existing = this.attached.get(input.alias);
    if (existing && !input.replace) {
      throw new Error(
        `Alias "${input.alias}" is already attached. Set replace=true to re-attach.`
      );
    }

    if (!existing && this.attached.size >= this.maxAttached) {
      throw new Error(
        `Upstream attachment limit reached (${this.maxAttached}). Detach an existing alias first.`
      );
    }

    const attached = await this.connectUpstream(input);
    try {
      const tools = await attached.client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b));

      if (existing) {
        await this.closeAttached(existing);
      }

      this.attached.set(input.alias, attached);
      void this.auditLogger?.log({
        action: 'upstream.mcp.attach',
        actor: 'admin',
        target: input.alias,
        result: 'success',
        details: {
          transport: attached.transportMode,
          target: attached.target,
          toolCount: toolNames.length,
          replaced: Boolean(existing)
        }
      });

      return {
        alias: input.alias,
        transport: attached.transportMode,
        target: attached.target,
        toolCount: toolNames.length,
        toolNames,
        attachedAt: attached.attachedAt
      };
    } catch (error) {
      await this.closeAttached(attached);
      throw error;
    }
  }

  private async detach(alias: string): Promise<z.infer<typeof UpstreamDetachOutputSchema>> {
    const existing = this.attached.get(alias);
    if (!existing) {
      return {
        alias,
        detached: false
      };
    }

    this.attached.delete(alias);
    await this.closeAttached(existing);
    void this.auditLogger?.log({
      action: 'upstream.mcp.detach',
      actor: 'admin',
      target: alias,
      result: 'success'
    });

    return {
      alias,
      detached: true
    };
  }

  private async closeAttached(upstream: AttachedUpstream): Promise<void> {
    if (upstream.transportMode === 'http') {
      try {
        await upstream.transportHandle.terminateSession();
      } catch {
        // Ignore explicit session termination failures.
      }
    }

    try {
      await upstream.client.close();
    } catch {
      // Ignore close failures during shutdown/replacement.
    }
  }

  private async connectUpstream(input: {
    transport: UpstreamTransportMode;
    command?: string;
    args: string[];
    env: Record<string, string>;
    cwd?: string;
    url?: string;
    headers: Record<string, string>;
  }): Promise<AttachedUpstream> {
    const client = new Client({
      name: 'dynamic-mcp-upstream-attach',
      version: serviceVersion
    });

    if (input.transport === 'stdio') {
      if (!input.command) {
        throw new Error('Field "command" is required when transport=stdio.');
      }

      const mergedEnv = {
        ...getDefaultEnvironment(),
        ...input.env
      };
      const transportHandle = new StdioClientTransport({
        command: input.command,
        ...(input.args.length > 0 ? { args: input.args } : {}),
        env: mergedEnv,
        ...(input.cwd ? { cwd: input.cwd } : {})
      });
      await client.connect(transportHandle);

      return {
        client,
        transportMode: 'stdio',
        target: input.command,
        attachedAt: new Date().toISOString(),
        transportHandle
      };
    }

    if (!input.url) {
      throw new Error('Field "url" is required when transport=http.');
    }

    const transportHandle = new StreamableHTTPClientTransport(
      new URL(input.url),
      Object.keys(input.headers).length > 0
        ? {
            requestInit: {
              headers: input.headers
            }
          }
        : undefined
    );
    await client.connect(transportHandle);

    return {
      client,
      transportMode: 'http',
      target: input.url,
      attachedAt: new Date().toISOString(),
      transportHandle
    };
  }

  private assertAdmin(providedToken: string | undefined): void {
    if (!this.adminToken) {
      throw new Error(
        'Unauthorized: upstream attach feature requires MCP_ADMIN_TOKEN to be configured.'
      );
    }

    if (!providedToken || providedToken !== this.adminToken) {
      throw new Error('Unauthorized: invalid admin token.');
    }
  }

  private async runMutation<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutationChain = previous.catch(() => undefined).then(() => gate);
    await previous.catch(() => undefined);

    try {
      return await work();
    } finally {
      release!();
    }
  }

  private async guarded(scope: string, work: () => Promise<CallToolResult>): Promise<CallToolResult> {
    try {
      return await this.executionGuard.run(scope, work);
    } catch (error) {
      void this.auditLogger?.log({
        action: scope,
        actor: 'system',
        result: 'error',
        details: {
          message: error instanceof Error ? error.message : String(error)
        }
      });
      return toErrorResult(error);
    }
  }
}

function toErrorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [textItem(message)]
  };
}
