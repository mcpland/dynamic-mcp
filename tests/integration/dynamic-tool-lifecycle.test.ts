/**
 * Integration test: Dynamic Tool Lifecycle (End-to-End)
 *
 * Tests the complete lifecycle of dynamic tools through the MCP protocol:
 * - Create → Get → List → Update → Enable/Disable → Delete
 * - Multiple tools coexistence
 * - Revision conflict detection across operations
 * - Tool persistence across MCP sessions (same file store)
 * - Dynamic tools appear/disappear from tools/list
 */
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditLogger } from '../../src/audit/logger.js';
import { createMcpServer } from '../../src/server/create-server.js';
import type { CreateMcpServerOptions } from '../../src/server/create-server.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const openedClients: Client[] = [];
const openedServers: Awaited<ReturnType<typeof createMcpServer>>[] = [];

afterEach(async () => {
  await Promise.all(openedClients.map((c) => c.close()));
  await Promise.all(openedServers.map((s) => s.close()));
  openedClients.length = 0;
  openedServers.length = 0;
});

function createTestAuditLogger(): AuditLogger {
  return new AuditLogger({
    enabled: false,
    filePath: '/tmp/dynamic-mcp-lifecycle-audit.log',
    maxEventBytes: 10_000,
    maxFileBytes: 100_000,
    maxFiles: 3,
    service: 'dynamic-mcp-lifecycle',
    serviceVersion: 'test'
  });
}

function buildConfig(storeFilePath: string): CreateMcpServerOptions {
  return {
    profile: 'enterprise',
    dynamic: {
      backend: 'file',
      storeFilePath,
      maxTools: 32,
      readOnly: false
    },
    sandbox: {
      dockerBinary: 'docker',
      memoryLimit: '512m',
      cpuLimit: '1',
      maxDependencies: 8,
      maxOutputBytes: 200_000,
      maxTimeoutMs: 60_000,
      allowedImages: ['node:lts-slim'],
      blockedPackages: [],
      sessionTimeoutSeconds: 1_800,
      maxSessions: 20
    },
    security: {
      toolMaxConcurrency: 8,
      toolMaxCallsPerWindow: 1000,
      toolRateWindowMs: 60_000
    },
    auth: { mode: 'none' },
    auditLogger: createTestAuditLogger()
  };
}

async function connectPair(config: CreateMcpServerOptions) {
  const server = await createMcpServer(config);
  const client = new Client({ name: 'lifecycle-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  openedServers.push(server);
  openedClients.push(client);

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe('dynamic tool lifecycle – end-to-end', () => {
  it('full CRUD lifecycle: create → get → update → enable/disable → delete', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-dynlife-'));
    const storeFile = join(storeRoot, 'tools.json');
    const { client } = await connectPair(buildConfig(storeFile));

    // --- CREATE ---
    const createResult = await client.callTool({
      name: 'dynamic.tool.create',
      arguments: {
        tool: {
          name: 'dynamic.greeter',
          title: 'Greeter Tool',
          description: 'Greets the user by name',
          code: 'return { greeting: `Hello, ${args.name}!` };'
        }
      }
    });
    expect(createResult.isError).not.toBe(true);
    const created = createResult.structuredContent as { tool: { name: string; revision: number } };
    expect(created.tool.name).toBe('dynamic.greeter');
    expect(created.tool.revision).toBe(1);

    // --- Visible in listTools ---
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === 'dynamic.greeter')).toBe(true);
    const greeterTool = tools.tools.find((t) => t.name === 'dynamic.greeter');
    expect(greeterTool?.description).toBe('Greets the user by name');

    // --- GET ---
    const getResult = await client.callTool({
      name: 'dynamic.tool.get',
      arguments: { name: 'dynamic.greeter' }
    });
    expect(getResult.isError).not.toBe(true);
    const gotten = getResult.structuredContent as {
      tool: { name: string; revision: number; code: string; title: string };
    };
    expect(gotten.tool.code).toContain('Hello');
    expect(gotten.tool.title).toBe('Greeter Tool');
    expect(gotten.tool.revision).toBe(1);

    // --- UPDATE ---
    const updateResult = await client.callTool({
      name: 'dynamic.tool.update',
      arguments: {
        name: 'dynamic.greeter',
        expectedRevision: 1,
        patch: {
          description: 'Greets the user v2',
          code: 'return { greeting: `Hi, ${args.name}!` };'
        }
      }
    });
    expect(updateResult.isError).not.toBe(true);
    const updated = updateResult.structuredContent as { tool: { revision: number } };
    expect(updated.tool.revision).toBe(2);

    // Verify update persisted
    const getAfterUpdate = await client.callTool({
      name: 'dynamic.tool.get',
      arguments: { name: 'dynamic.greeter' }
    });
    const afterUpdate = getAfterUpdate.structuredContent as {
      tool: { description: string; revision: number; code: string };
    };
    expect(afterUpdate.tool.description).toBe('Greets the user v2');
    expect(afterUpdate.tool.revision).toBe(2);
    expect(afterUpdate.tool.code).toContain('Hi,');

    // --- DISABLE ---
    const disableResult = await client.callTool({
      name: 'dynamic.tool.enable',
      arguments: { name: 'dynamic.greeter', enabled: false }
    });
    expect(disableResult.isError).not.toBe(true);

    // Disabled tool should NOT be in listTools
    const toolsAfterDisable = await client.listTools();
    expect(toolsAfterDisable.tools.some((t) => t.name === 'dynamic.greeter')).toBe(false);

    // But still accessible via dynamic.tool.get
    const getDisabled = await client.callTool({
      name: 'dynamic.tool.get',
      arguments: { name: 'dynamic.greeter' }
    });
    expect(getDisabled.isError).not.toBe(true);
    const disabledTool = getDisabled.structuredContent as { tool: { enabled: boolean } };
    expect(disabledTool.tool.enabled).toBe(false);

    // --- RE-ENABLE ---
    const enableResult = await client.callTool({
      name: 'dynamic.tool.enable',
      arguments: { name: 'dynamic.greeter', enabled: true }
    });
    expect(enableResult.isError).not.toBe(true);

    const toolsAfterEnable = await client.listTools();
    expect(toolsAfterEnable.tools.some((t) => t.name === 'dynamic.greeter')).toBe(true);

    // --- DELETE ---
    const deleteResult = await client.callTool({
      name: 'dynamic.tool.delete',
      arguments: { name: 'dynamic.greeter' }
    });
    expect(deleteResult.isError).not.toBe(true);

    // Verify gone from listTools
    const toolsAfterDelete = await client.listTools();
    expect(toolsAfterDelete.tools.some((t) => t.name === 'dynamic.greeter')).toBe(false);

    // Verify gone from dynamic.tool.get
    const getMissing = await client.callTool({
      name: 'dynamic.tool.get',
      arguments: { name: 'dynamic.greeter' }
    });
    expect(getMissing.isError).toBe(true);
  });

  it('revision conflict is detected across operations', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-dynconflict-'));
    const storeFile = join(storeRoot, 'tools.json');
    const { client } = await connectPair(buildConfig(storeFile));

    // Create a tool
    await client.callTool({
      name: 'dynamic.tool.create',
      arguments: {
        tool: {
          name: 'dynamic.conflict',
          description: 'conflict test',
          code: 'return 1;'
        }
      }
    });

    // Update with correct revision
    const ok = await client.callTool({
      name: 'dynamic.tool.update',
      arguments: {
        name: 'dynamic.conflict',
        expectedRevision: 1,
        patch: { description: 'v2' }
      }
    });
    expect(ok.isError).not.toBe(true);

    // Try again with the STALE revision 1 (should be 2 now)
    const stale = await client.callTool({
      name: 'dynamic.tool.update',
      arguments: {
        name: 'dynamic.conflict',
        expectedRevision: 1,
        patch: { description: 'v3-stale' }
      }
    });
    expect(stale.isError).toBe(true);
    expect((stale.content[0] as { text: string }).text).toMatch(/revision/i);

    // Verify v2 is still the current state
    const get = await client.callTool({
      name: 'dynamic.tool.get',
      arguments: { name: 'dynamic.conflict' }
    });
    expect((get.structuredContent as { tool: { description: string } }).tool.description).toBe(
      'v2'
    );
  });

  it('multiple dynamic tools coexist and list correctly', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-dynmulti-'));
    const storeFile = join(storeRoot, 'tools.json');
    const { client } = await connectPair(buildConfig(storeFile));

    // Create 3 tools
    for (const name of ['dynamic.alpha', 'dynamic.beta', 'dynamic.gamma']) {
      const result = await client.callTool({
        name: 'dynamic.tool.create',
        arguments: {
          tool: { name, description: `Tool ${name}`, code: `return "${name}";` }
        }
      });
      expect(result.isError).not.toBe(true);
    }

    // All 3 should appear in listTools
    const tools = await client.listTools();
    const dynamicTools = tools.tools.filter((t) => t.name.startsWith('dynamic.'));
    const managementTools = [
      'dynamic.tool.create',
      'dynamic.tool.update',
      'dynamic.tool.delete',
      'dynamic.tool.list',
      'dynamic.tool.get',
      'dynamic.tool.enable'
    ];
    const userDynamicTools = dynamicTools.filter((t) => !managementTools.includes(t.name));
    expect(userDynamicTools.length).toBe(3);

    // All 3 in dynamic.tool.list
    const listResult = await client.callTool({
      name: 'dynamic.tool.list',
      arguments: { includeCode: false }
    });
    expect(listResult.isError).not.toBe(true);
    const listed = listResult.structuredContent as {
      tools: Array<{ name: string }>;
    };
    const listedNames = listed.tools.map((t) => t.name);
    expect(listedNames).toContain('dynamic.alpha');
    expect(listedNames).toContain('dynamic.beta');
    expect(listedNames).toContain('dynamic.gamma');

    // Delete one
    await client.callTool({
      name: 'dynamic.tool.delete',
      arguments: { name: 'dynamic.beta' }
    });

    // Verify only 2 remain
    const afterDelete = await client.callTool({
      name: 'dynamic.tool.list',
      arguments: { includeCode: false }
    });
    const remaining = afterDelete.structuredContent as {
      tools: Array<{ name: string }>;
    };
    expect(remaining.tools.map((t) => t.name)).not.toContain('dynamic.beta');
    expect(remaining.tools.length).toBe(2);
  });

  it('persists tools across MCP sessions sharing the same file store', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-dynpersist-'));
    const storeFile = join(storeRoot, 'tools.json');

    // --- Session 1: Create a tool ---
    {
      const { client, server } = await connectPair(buildConfig(storeFile));

      await client.callTool({
        name: 'dynamic.tool.create',
        arguments: {
          tool: {
            name: 'dynamic.persistent',
            description: 'persists across sessions',
            code: 'return "persistent";'
          }
        }
      });

      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === 'dynamic.persistent')).toBe(true);

      // Close session 1
      await client.close();
      await server.close();
      openedClients.length = 0;
      openedServers.length = 0;
    }

    // --- Session 2: Verify tool still exists ---
    {
      const { client } = await connectPair(buildConfig(storeFile));

      // Tool should be loaded from file
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === 'dynamic.persistent')).toBe(true);

      // Get returns the tool with correct data
      const get = await client.callTool({
        name: 'dynamic.tool.get',
        arguments: { name: 'dynamic.persistent' }
      });
      expect(get.isError).not.toBe(true);
      const tool = get.structuredContent as {
        tool: { name: string; description: string; code: string; revision: number };
      };
      expect(tool.tool.description).toBe('persists across sessions');
      expect(tool.tool.code).toContain('persistent');
      expect(tool.tool.revision).toBe(1);

      // Update it in session 2
      await client.callTool({
        name: 'dynamic.tool.update',
        arguments: {
          name: 'dynamic.persistent',
          expectedRevision: 1,
          patch: { description: 'updated in session 2' }
        }
      });

      // Close session 2
      await client.close();
      openedClients.length = 0;
      openedServers.forEach((s) => void s.close());
      openedServers.length = 0;
    }

    // --- Session 3: Verify update persisted ---
    {
      const { client } = await connectPair(buildConfig(storeFile));

      const get = await client.callTool({
        name: 'dynamic.tool.get',
        arguments: { name: 'dynamic.persistent' }
      });
      const tool = get.structuredContent as {
        tool: { description: string; revision: number };
      };
      expect(tool.tool.description).toBe('updated in session 2');
      expect(tool.tool.revision).toBe(2);
    }
  });

  it('dynamic.tool.list with includeCode=true returns code field', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-dyncode-'));
    const storeFile = join(storeRoot, 'tools.json');
    const { client } = await connectPair(buildConfig(storeFile));

    await client.callTool({
      name: 'dynamic.tool.create',
      arguments: {
        tool: {
          name: 'dynamic.codeinlist',
          description: 'code in list test',
          code: 'return "code-visible";'
        }
      }
    });

    // Without code
    const noCode = await client.callTool({
      name: 'dynamic.tool.list',
      arguments: { includeCode: false }
    });
    const toolNoCode = (
      noCode.structuredContent as { tools: Array<{ name: string; code?: string }> }
    ).tools.find((t) => t.name === 'dynamic.codeinlist');
    expect(toolNoCode?.code).toBeUndefined();

    // With code
    const withCode = await client.callTool({
      name: 'dynamic.tool.list',
      arguments: { includeCode: true }
    });
    const toolWithCode = (
      withCode.structuredContent as { tools: Array<{ name: string; code?: string }> }
    ).tools.find((t) => t.name === 'dynamic.codeinlist');
    expect(toolWithCode?.code).toBe('return "code-visible";');
  });

  it('creating a duplicate tool name is rejected', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-dyndup-'));
    const storeFile = join(storeRoot, 'tools.json');
    const { client } = await connectPair(buildConfig(storeFile));

    await client.callTool({
      name: 'dynamic.tool.create',
      arguments: {
        tool: { name: 'dynamic.dup', description: 'first', code: 'return 1;' }
      }
    });

    const dup = await client.callTool({
      name: 'dynamic.tool.create',
      arguments: {
        tool: { name: 'dynamic.dup', description: 'second', code: 'return 2;' }
      }
    });
    expect(dup.isError).toBe(true);
    expect((dup.content[0] as { text: string }).text).toMatch(/already exists|duplicate/i);
  });
});
