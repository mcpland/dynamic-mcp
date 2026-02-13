import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditLogger } from '../src/audit/logger.js';
import { createMcpServer } from '../src/server/create-server.js';

const openedClients: Client[] = [];
const openedServers: Awaited<ReturnType<typeof createMcpServer>>[] = [];

afterEach(async () => {
  await Promise.all(openedClients.map((client) => client.close()));
  await Promise.all(openedServers.map((server) => server.close()));
  openedClients.length = 0;
  openedServers.length = 0;
});

describe('dynamic tool service', () => {
  it('creates and registers dynamic tools at runtime', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-service-test-'));
    const server = await createMcpServer({
      ...buildServerConfig(storeRoot)
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const createResult = await client.callTool({
      name: 'dynamic.tool.create',
      arguments: {
        tool: {
          name: 'dynamic.hello',
          description: 'hello dynamic',
          code: 'console.log(args.name);'
        }
      }
    });

    expect(createResult.isError).not.toBe(true);

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === 'dynamic.hello')).toBe(true);

    const runResult = await client.callTool({
      name: 'dynamic.hello',
      arguments: {
        args: {
          name: 'world'
        }
      }
    });

    expect(runResult.isError).toBe(true);
    expect(runResult.content[0]?.type).toBe('text');

    const firstUpdate = await client.callTool({
      name: 'dynamic.tool.update',
      arguments: {
        name: 'dynamic.hello',
        expectedRevision: 1,
        patch: {
          description: 'hello dynamic v2'
        }
      }
    });
    expect(firstUpdate.isError).not.toBe(true);

    const staleUpdate = await client.callTool({
      name: 'dynamic.tool.update',
      arguments: {
        name: 'dynamic.hello',
        expectedRevision: 1,
        patch: {
          description: 'hello dynamic stale'
        }
      }
    });
    expect(staleUpdate.isError).toBe(true);
    expect(staleUpdate.content[0]?.type).toBe('text');
  });

  it('enforces admin token for privileged dynamic tools when configured', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-service-auth-test-'));
    const server = await createMcpServer({
      ...buildServerConfig(storeRoot),
      dynamic: {
        backend: 'file',
        storeFilePath: join(storeRoot, 'tools.json'),
        maxTools: 10,
        adminToken: 'top-secret'
      }
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const unauthorized = await client.callTool({
      name: 'dynamic.tool.list',
      arguments: {}
    });
    expect(unauthorized.isError).toBe(true);

    const authorized = await client.callTool({
      name: 'dynamic.tool.list',
      arguments: {
        adminToken: 'top-secret'
      }
    });
    expect(authorized.isError).not.toBe(true);
  });
});

function buildServerConfig(storeRoot: string) {
  return {
    dynamic: {
      backend: 'file',
      storeFilePath: join(storeRoot, 'tools.json'),
      maxTools: 10
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
    auth: {
      mode: 'none'
    },
    auditLogger: createTestAuditLogger()
  };
}

function createTestAuditLogger(): AuditLogger {
  return new AuditLogger({
    enabled: false,
    filePath: '/tmp/dynamic-mcp-test-audit.log',
    maxEventBytes: 10_000,
    maxFileBytes: 100_000,
    maxFiles: 3,
    service: 'dynamic-mcp-test',
    serviceVersion: 'test'
  });
}
