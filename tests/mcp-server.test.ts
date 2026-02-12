import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createMcpServer } from '../src/server/create-server.js';

const openedClients: Client[] = [];
const openedServers: ReturnType<typeof createMcpServer>[] = [];

afterEach(async () => {
  await Promise.all(openedClients.map((client) => client.close()));
  await Promise.all(openedServers.map((server) => server.close()));
  openedClients.length = 0;
  openedServers.length = 0;
});

describe('createMcpServer', () => {
  it('registers tools and executes dev.echo', async () => {
    const server = createMcpServer();
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(toolNames).toContain('system.health');
    expect(toolNames).toContain('dev.echo');
    expect(toolNames).toContain('time.now');

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
