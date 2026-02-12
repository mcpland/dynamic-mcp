import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { DynamicToolExecutionEngine } from './executor.js';
import type { DynamicToolRegistry } from './registry.js';
import {
  DynamicToolCreateSchema,
  DynamicToolUpdateSchema,
  dynamicToolNameRegex
} from './spec.js';
import type { DynamicToolCreate, DynamicToolRecord, DynamicToolUpdate } from './spec.js';

const DynamicInvocationSchema = z.object({
  args: z.record(z.string(), z.unknown()).default({})
});

const AdminTokenSchema = {
  adminToken: z.string().optional()
};

const DynamicCreateToolInputSchema = {
  ...AdminTokenSchema,
  tool: DynamicToolCreateSchema
};

const DynamicUpdateToolInputSchema = {
  ...AdminTokenSchema,
  name: z.string().regex(dynamicToolNameRegex),
  patch: DynamicToolUpdateSchema
};

const DynamicLookupToolInputSchema = {
  ...AdminTokenSchema,
  name: z.string().regex(dynamicToolNameRegex)
};

const DynamicListToolInputSchema = {
  ...AdminTokenSchema,
  includeCode: z.boolean().default(false)
};

const DynamicEnableToolInputSchema = {
  ...AdminTokenSchema,
  name: z.string().regex(dynamicToolNameRegex),
  enabled: z.boolean()
};

const textItem = (text: string) => ({ type: 'text' as const, text });

export interface DynamicToolServiceOptions {
  server: McpServer;
  registry: DynamicToolRegistry;
  executionEngine: DynamicToolExecutionEngine;
  adminToken?: string;
}

export class DynamicToolService {
  private readonly server: McpServer;
  private readonly registry: DynamicToolRegistry;
  private readonly executionEngine: DynamicToolExecutionEngine;
  private readonly adminToken?: string;
  private readonly runtimeToolHandles = new Map<string, RegisteredTool>();

  constructor(options: DynamicToolServiceOptions) {
    this.server = options.server;
    this.registry = options.registry;
    this.executionEngine = options.executionEngine;
    this.adminToken = options.adminToken;
  }

  async initialize(): Promise<void> {
    await this.registry.load();
    await this.refreshAllRuntimeTools();
    this.registerManagementTools();
  }

  private registerManagementTools(): void {
    this.server.registerTool(
      'dynamic.tool.list',
      {
        title: 'List Dynamic Tools',
        description: 'List all dynamic tools currently registered in local storage',
        inputSchema: DynamicListToolInputSchema
      },
      async ({ adminToken, includeCode }) => {
        try {
          this.assertAdmin(adminToken);
          const tools = this.registry
            .list()
            .map((record) => this.toToolView(record, includeCode));

          return {
            content: [textItem(JSON.stringify(tools, null, 2))],
            structuredContent: {
              tools
            }
          };
        } catch (error) {
          return toErrorResult(error);
        }
      }
    );

    this.server.registerTool(
      'dynamic.tool.get',
      {
        title: 'Get Dynamic Tool',
        description: 'Get one dynamic tool definition by name',
        inputSchema: DynamicLookupToolInputSchema
      },
      async ({ adminToken, name }) => {
        try {
          this.assertAdmin(adminToken);
          const record = this.registry.get(name);
          if (!record) {
            return {
              isError: true,
              content: [textItem(`Dynamic tool not found: ${name}`)]
            };
          }

          const tool = this.toToolView(record, true);
          return {
            content: [textItem(JSON.stringify(tool, null, 2))],
            structuredContent: {
              tool
            }
          };
        } catch (error) {
          return toErrorResult(error);
        }
      }
    );

    this.server.registerTool(
      'dynamic.tool.create',
      {
        title: 'Create Dynamic Tool',
        description: 'Create and register a new dynamic tool',
        inputSchema: DynamicCreateToolInputSchema
      },
      async ({ adminToken, tool }) => {
        try {
          this.assertAdmin(adminToken);
          this.assertNameAllowed(tool.name);

          const created = await this.registry.create(tool);
          await this.applyRuntimeTool(created);
          this.server.sendToolListChanged();

          const view = this.toToolView(created, false);
          return {
            content: [textItem(`Created dynamic tool: ${created.name}`)],
            structuredContent: {
              tool: view
            }
          };
        } catch (error) {
          return toErrorResult(error);
        }
      }
    );

    this.server.registerTool(
      'dynamic.tool.update',
      {
        title: 'Update Dynamic Tool',
        description: 'Update an existing dynamic tool definition',
        inputSchema: DynamicUpdateToolInputSchema
      },
      async ({ adminToken, name, patch }) => {
        try {
          this.assertAdmin(adminToken);
          this.assertNameAllowed(name);

          const updated = await this.registry.update(name, patch);
          await this.applyRuntimeTool(updated);
          this.server.sendToolListChanged();

          const view = this.toToolView(updated, false);
          return {
            content: [textItem(`Updated dynamic tool: ${updated.name}`)],
            structuredContent: {
              tool: view
            }
          };
        } catch (error) {
          return toErrorResult(error);
        }
      }
    );

    this.server.registerTool(
      'dynamic.tool.delete',
      {
        title: 'Delete Dynamic Tool',
        description: 'Delete a dynamic tool and unregister it from MCP',
        inputSchema: DynamicLookupToolInputSchema
      },
      async ({ adminToken, name }) => {
        try {
          this.assertAdmin(adminToken);
          this.assertNameAllowed(name);

          const removed = await this.registry.remove(name);
          this.removeRuntimeTool(name);
          this.server.sendToolListChanged();

          if (!removed) {
            return {
              isError: true,
              content: [textItem(`Dynamic tool not found: ${name}`)]
            };
          }

          return {
            content: [textItem(`Deleted dynamic tool: ${name}`)]
          };
        } catch (error) {
          return toErrorResult(error);
        }
      }
    );

    this.server.registerTool(
      'dynamic.tool.enable',
      {
        title: 'Enable Or Disable Dynamic Tool',
        description: 'Enable or disable a dynamic tool at runtime',
        inputSchema: DynamicEnableToolInputSchema
      },
      async ({ adminToken, name, enabled }) => {
        try {
          this.assertAdmin(adminToken);
          this.assertNameAllowed(name);

          const updated = await this.registry.setEnabled(name, enabled);
          await this.applyRuntimeTool(updated);
          this.server.sendToolListChanged();

          return {
            content: [textItem(`${enabled ? 'Enabled' : 'Disabled'} dynamic tool: ${name}`)],
            structuredContent: {
              tool: this.toToolView(updated, false)
            }
          };
        } catch (error) {
          return toErrorResult(error);
        }
      }
    );
  }

  private async refreshAllRuntimeTools(): Promise<void> {
    const records = this.registry.list();
    for (const record of records) {
      await this.applyRuntimeTool(record);
    }
  }

  private async applyRuntimeTool(record: DynamicToolRecord): Promise<void> {
    this.removeRuntimeTool(record.name);

    if (!record.enabled) {
      return;
    }

    const handle = this.server.registerTool(
      record.name,
      {
        title: record.title,
        description: record.description,
        inputSchema: DynamicInvocationSchema
      },
      async ({ args }) => {
        return this.executionEngine.execute(record, args);
      }
    );

    this.runtimeToolHandles.set(record.name, handle);
  }

  private removeRuntimeTool(name: string): void {
    const existing = this.runtimeToolHandles.get(name);
    if (existing) {
      existing.remove();
      this.runtimeToolHandles.delete(name);
    }
  }

  private assertAdmin(providedToken: string | undefined): void {
    if (!this.adminToken) {
      return;
    }

    if (!providedToken || providedToken !== this.adminToken) {
      throw new Error('Unauthorized: invalid admin token.');
    }
  }

  private assertNameAllowed(name: string): void {
    if (name.startsWith('dynamic.tool.')) {
      throw new Error(`Reserved tool name prefix is not allowed: ${name}`);
    }
  }

  private toToolView(record: DynamicToolRecord, includeCode: boolean): ToolView {
    const view: ToolView = {
      name: record.name,
      title: record.title,
      description: record.description,
      image: record.image,
      timeoutMs: record.timeoutMs,
      dependencies: record.dependencies,
      enabled: record.enabled,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: record.revision,
      codeSizeBytes: Buffer.byteLength(record.code, 'utf8')
    };

    if (includeCode) {
      view.code = record.code;
    }

    return view;
  }
}

type ToolView = {
  name: string;
  title?: string;
  description: string;
  image: string;
  timeoutMs: number;
  dependencies: DynamicToolRecord['dependencies'];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  revision: number;
  codeSizeBytes: number;
  code?: string;
};

function toErrorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [textItem(message)]
  };
}

export function assertValidCreateInput(input: DynamicToolCreate): DynamicToolCreate {
  return DynamicToolCreateSchema.parse(input);
}

export function assertValidUpdateInput(input: DynamicToolUpdate): DynamicToolUpdate {
  return DynamicToolUpdateSchema.parse(input);
}
