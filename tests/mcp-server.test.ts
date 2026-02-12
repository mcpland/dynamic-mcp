import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

describe('createMcpServer', () => {
  it('registers tools and executes dev.echo', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-server-test-'));
    const server = await createMcpServer({
      dynamic: {
        backend: 'file',
        storeFilePath: join(storeRoot, 'tools.json'),
        maxTools: 32
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
      auditLogger: createTestAuditLogger()
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(toolNames).toContain('system.health');
    expect(toolNames).toContain('system.guard_metrics');
    expect(toolNames).toContain('dev.echo');
    expect(toolNames).toContain('time.now');
    expect(toolNames).toContain('sandbox.initialize');
    expect(toolNames).toContain('sandbox.exec');
    expect(toolNames).toContain('sandbox.run_js');
    expect(toolNames).toContain('sandbox.stop');

    const result = await client.callTool({
      name: 'dev.echo',
      arguments: {
        message: 'hello mcp',
        uppercase: true
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      message: 'HELLO MCP',
      length: 9
    });
  });
});

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
