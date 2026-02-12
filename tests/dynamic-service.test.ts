import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

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
      dynamic: {
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
      }
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
  });
});
