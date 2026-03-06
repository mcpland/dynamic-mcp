import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer(
  {
    name: 'upstream-stdio-fixture',
    version: '1.0.0'
  },
  {
    capabilities: {
      logging: {}
    }
  }
);

server.registerTool(
  'fixture.ping',
  {
    title: 'Fixture Ping',
    description: 'Simple fixture tool used by upstream attach integration tests'
  },
  async () => {
    return {
      content: [
        {
          type: 'text',
          text: 'pong'
        }
      ]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
