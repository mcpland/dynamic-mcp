import { randomUUID } from 'node:crypto';

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { DynamicToolExecutionEngine } from './executor.js';
import {
  publishDynamicRegistryChange,
  subscribeDynamicRegistryChanges
} from './change-bus.js';
import type { DynamicToolRegistryPort } from './registry-port.js';
import {
  DynamicToolCreateSchema,
  DynamicToolUpdateSchema,
  dynamicToolNameRegex
} from './spec.js';
import type { DynamicToolCreate, DynamicToolRecord, DynamicToolUpdate } from './spec.js';
import type { ToolExecutionGuard } from '../security/guard.js';
import type { AuditLogger } from '../audit/logger.js';

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
  patch: DynamicToolUpdateSchema,
  expectedRevision: z.number().int().positive().optional()
};

const DynamicLookupToolInputSchema = {
  ...AdminTokenSchema,
  name: z.string().regex(dynamicToolNameRegex)
};

const DynamicDeleteToolInputSchema = {
  ...AdminTokenSchema,
  name: z.string().regex(dynamicToolNameRegex),
  expectedRevision: z.number().int().positive().optional()
};

const DynamicListToolInputSchema = {
  ...AdminTokenSchema,
  includeCode: z.boolean().default(false)
};

const DynamicEnableToolInputSchema = {
  ...AdminTokenSchema,
  name: z.string().regex(dynamicToolNameRegex),
  enabled: z.boolean(),
  expectedRevision: z.number().int().positive().optional()
};

const textItem = (text: string) => ({ type: 'text' as const, text });

export interface DynamicToolServiceOptions {
  server: McpServer;
  registry: DynamicToolRegistryPort;
  executionEngine: DynamicToolExecutionEngine;
  executionGuard: ToolExecutionGuard;
  auditLogger?: AuditLogger;
  adminToken?: string;
  readOnly: boolean;
}

export class DynamicToolService {
  private readonly serviceId = randomUUID();
  private readonly server: McpServer;
  private readonly registry: DynamicToolRegistryPort;
  private readonly executionEngine: DynamicToolExecutionEngine;
  private readonly executionGuard: ToolExecutionGuard;
  private readonly auditLogger?: AuditLogger;
  private readonly adminToken?: string;
  private readonly readOnly: boolean;
  private readonly runtimeToolHandles = new Map<string, RegisteredTool>();
  private readonly runtimeToolRevisions = new Map<string, number>();
  private unsubscribeRegistryChanges?: () => void;
  private syncInFlight = false;
  private syncPending = false;

  constructor(options: DynamicToolServiceOptions) {
    this.server = options.server;
    this.registry = options.registry;
    this.executionEngine = options.executionEngine;
    this.executionGuard = options.executionGuard;
    this.auditLogger = options.auditLogger;
    this.adminToken = options.adminToken;
    this.readOnly = options.readOnly;
  }

  async initialize(): Promise<void> {
    await this.registry.load();
    await this.refreshAllRuntimeTools();
    this.registerManagementTools();
    this.unsubscribeRegistryChanges = subscribeDynamicRegistryChanges((event) => {
      if (event.originId === this.serviceId) {
        return;
      }

      this.scheduleRegistryRefresh();
    });
  }

  dispose(): void {
    if (this.unsubscribeRegistryChanges) {
      this.unsubscribeRegistryChanges();
      this.unsubscribeRegistryChanges = undefined;
    }

    for (const name of [...this.runtimeToolHandles.keys()]) {
      this.removeRuntimeTool(name);
    }
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
        return this.guarded('dynamic.tool.list', async () => {
          try {
            this.assertAdmin(adminToken);
            const tools = (await this.registry.list()).map((record) =>
              this.toToolView(record, includeCode)
            );

            return {
              content: [textItem(JSON.stringify(tools, null, 2))],
              structuredContent: {
                tools
              }
            };
          } catch (error) {
            return toErrorResult(error);
          }
        });
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
        return this.guarded('dynamic.tool.get', async () => {
          try {
            this.assertAdmin(adminToken);
            const record = await this.registry.get(name);
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
        });
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
        return this.guarded('dynamic.tool.create', async () => {
          try {
            this.assertAdmin(adminToken);
            this.assertNameAllowed(tool.name);
            this.assertWritesAllowed('create');

            const created = await this.registry.create(tool);
            await this.applyRuntimeTool(created);
            this.server.sendToolListChanged();
            this.broadcastRegistryChange('create', created.name);
            void this.auditLogger?.log({
              action: 'dynamic.tool.create',
              actor: 'admin',
              target: created.name,
              result: 'success'
            });

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
        });
      }
    );

    this.server.registerTool(
      'dynamic.tool.update',
      {
        title: 'Update Dynamic Tool',
        description: 'Update an existing dynamic tool definition',
        inputSchema: DynamicUpdateToolInputSchema
      },
      async ({ adminToken, name, patch, expectedRevision }) => {
        return this.guarded('dynamic.tool.update', async () => {
          try {
            this.assertAdmin(adminToken);
            this.assertNameAllowed(name);
            this.assertWritesAllowed('update');

            const updated = await this.registry.update(name, patch, expectedRevision);
            await this.applyRuntimeTool(updated);
            this.server.sendToolListChanged();
            this.broadcastRegistryChange('update', updated.name);
            void this.auditLogger?.log({
              action: 'dynamic.tool.update',
              actor: 'admin',
              target: updated.name,
              result: 'success'
            });

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
        });
      }
    );

    this.server.registerTool(
      'dynamic.tool.delete',
      {
        title: 'Delete Dynamic Tool',
        description: 'Delete a dynamic tool and unregister it from MCP',
        inputSchema: DynamicDeleteToolInputSchema
      },
      async ({ adminToken, name, expectedRevision }) => {
        return this.guarded('dynamic.tool.delete', async () => {
          try {
            this.assertAdmin(adminToken);
            this.assertNameAllowed(name);
            this.assertWritesAllowed('delete');

            const removed = await this.registry.remove(name, expectedRevision);
            this.removeRuntimeTool(name);
            this.server.sendToolListChanged();

            if (!removed) {
              return {
                isError: true,
                content: [textItem(`Dynamic tool not found: ${name}`)]
              };
            }

            this.broadcastRegistryChange('delete', name);
            void this.auditLogger?.log({
              action: 'dynamic.tool.delete',
              actor: 'admin',
              target: name,
              result: 'success'
            });

            return {
              content: [textItem(`Deleted dynamic tool: ${name}`)]
            };
          } catch (error) {
            return toErrorResult(error);
          }
        });
      }
    );

    this.server.registerTool(
      'dynamic.tool.enable',
      {
        title: 'Enable Or Disable Dynamic Tool',
        description: 'Enable or disable a dynamic tool at runtime',
        inputSchema: DynamicEnableToolInputSchema
      },
      async ({ adminToken, name, enabled, expectedRevision }) => {
        return this.guarded('dynamic.tool.enable', async () => {
          try {
            this.assertAdmin(adminToken);
            this.assertNameAllowed(name);
            this.assertWritesAllowed('enable/disable');

            const updated = await this.registry.setEnabled(name, enabled, expectedRevision);
            await this.applyRuntimeTool(updated);
            this.server.sendToolListChanged();
            this.broadcastRegistryChange(enabled ? 'enable' : 'disable', name);
            void this.auditLogger?.log({
              action: enabled ? 'dynamic.tool.enable' : 'dynamic.tool.disable',
              actor: 'admin',
              target: name,
              result: 'success'
            });

            return {
              content: [textItem(`${enabled ? 'Enabled' : 'Disabled'} dynamic tool: ${name}`)],
              structuredContent: {
                tool: this.toToolView(updated, false)
              }
            };
          } catch (error) {
            return toErrorResult(error);
          }
        });
      }
    );
  }

  private async refreshAllRuntimeTools(): Promise<void> {
    const records = await this.registry.list();
    await this.syncRuntimeTools(records);
  }

  private async applyRuntimeTool(record: DynamicToolRecord): Promise<boolean> {
    const existingRevision = this.runtimeToolRevisions.get(record.name);
    const hasRegisteredHandle = this.runtimeToolHandles.has(record.name);

    if (!record.enabled) {
      if (!hasRegisteredHandle) {
        return false;
      }

      this.removeRuntimeTool(record.name);
      return true;
    }

    if (hasRegisteredHandle && existingRevision === record.revision) {
      return false;
    }

    this.removeRuntimeTool(record.name);

    const handle = this.server.registerTool(
      record.name,
      {
        title: record.title,
        description: record.description,
        inputSchema: DynamicInvocationSchema
      },
      async ({ args }) => {
        return this.guarded(`dynamic.exec.${record.name}`, async () => {
          return this.executionEngine.execute(record, args);
        });
      }
    );

    this.runtimeToolHandles.set(record.name, handle);
    this.runtimeToolRevisions.set(record.name, record.revision);
    return true;
  }

  private removeRuntimeTool(name: string): void {
    const existing = this.runtimeToolHandles.get(name);
    if (existing) {
      existing.remove();
      this.runtimeToolHandles.delete(name);
    }

    this.runtimeToolRevisions.delete(name);
  }

  private async syncRuntimeTools(records: DynamicToolRecord[]): Promise<boolean> {
    let changed = false;
    const knownNames = new Set(records.map((record) => record.name));

    for (const existingName of [...this.runtimeToolHandles.keys()]) {
      if (!knownNames.has(existingName)) {
        this.removeRuntimeTool(existingName);
        changed = true;
      }
    }

    for (const record of records) {
      const recordChanged = await this.applyRuntimeTool(record);
      changed = changed || recordChanged;
    }

    return changed;
  }

  private scheduleRegistryRefresh(): void {
    if (this.syncInFlight) {
      this.syncPending = true;
      return;
    }

    this.syncInFlight = true;
    void this.runRegistryRefreshLoop();
  }

  private async runRegistryRefreshLoop(): Promise<void> {
    while (true) {
      this.syncPending = false;

      try {
        await this.registry.reload();
        const changed = await this.syncRuntimeTools(await this.registry.list());
        if (changed) {
          this.server.sendToolListChanged();
        }
      } catch (error) {
        void this.auditLogger?.log({
          action: 'dynamic.registry.refresh',
          actor: 'system',
          result: 'error',
          details: {
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }

      if (!this.syncPending) {
        break;
      }
    }

    this.syncInFlight = false;
  }

  private broadcastRegistryChange(
    action: 'create' | 'update' | 'delete' | 'enable' | 'disable',
    target: string
  ): void {
    publishDynamicRegistryChange({
      originId: this.serviceId,
      action,
      target
    });
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

    if (name === 'run_js_ephemeral') {
      throw new Error(`Reserved built-in tool name is not allowed: ${name}`);
    }
  }

  private assertWritesAllowed(operation: string): void {
    if (this.readOnly) {
      throw new Error(
        `Dynamic registry is read-only; cannot ${operation} tools while MCP_DYNAMIC_READ_ONLY is enabled.`
      );
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
