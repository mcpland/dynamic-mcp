import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const serviceVersion = '0.1.0';

const HealthOutputSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().int().nonnegative()
});

const EchoInputSchema = {
  message: z.string().min(1).describe('Message to echo back'),
  uppercase: z.boolean().default(false).describe('Convert the message to upper case')
};

const EchoOutputSchema = z.object({
  message: z.string(),
  length: z.number().int().nonnegative()
});

const TimeInputSchema = {
  timeZone: z.string().optional().describe('Optional IANA timezone, e.g. Asia/Shanghai')
};

const TimeOutputSchema = z.object({
  iso: z.string(),
  unixSeconds: z.number().int(),
  timeZone: z.string()
});

export function createMcpServer(): McpServer {
  const startedAt = Date.now();

  const server = new McpServer(
    {
      name: 'dynamic-mcp',
      version: serviceVersion,
      websiteUrl: 'https://github.com/modelcontextprotocol/typescript-sdk'
    },
    {
      capabilities: {
        logging: {}
      }
    }
  );

  server.registerTool(
    'system.health',
    {
      title: 'System Health',
      description: 'Return server liveness and uptime info',
      outputSchema: HealthOutputSchema
    },
    async () => {
      const output = {
        status: 'ok' as const,
        service: 'dynamic-mcp',
        version: serviceVersion,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(output)
          }
        ],
        structuredContent: output
      };
    }
  );

  server.registerTool(
    'dev.echo',
    {
      title: 'Developer Echo',
      description: 'Echo user input and return deterministic structured output',
      inputSchema: EchoInputSchema,
      outputSchema: EchoOutputSchema
    },
    async ({ message, uppercase }) => {
      const normalized = uppercase ? message.toUpperCase() : message;
      const output = {
        message: normalized,
        length: normalized.length
      };

      return {
        content: [
          {
            type: 'text',
            text: normalized
          }
        ],
        structuredContent: output
      };
    }
  );

  server.registerTool(
    'time.now',
    {
      title: 'Current Time',
      description: 'Return current server time in ISO format',
      inputSchema: TimeInputSchema,
      outputSchema: TimeOutputSchema
    },
    async ({ timeZone }) => {
      const effectiveTimeZone = timeZone ?? 'UTC';

      if (!isValidTimeZone(effectiveTimeZone)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Invalid IANA timezone: ${effectiveTimeZone}`
            }
          ]
        };
      }

      const now = new Date();
      const output = {
        iso: now.toISOString(),
        unixSeconds: Math.floor(now.getTime() / 1000),
        timeZone: effectiveTimeZone
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(output)
          }
        ],
        structuredContent: output
      };
    }
  );

  server.registerResource(
    'service.meta',
    'dynamic://service/meta',
    {
      title: 'Service Metadata',
      description: 'Basic metadata for this MCP server',
      mimeType: 'application/json'
    },
    async (uri) => {
      const payload = {
        name: 'dynamic-mcp',
        version: serviceVersion,
        transports: ['stdio', 'http'],
        protocol: 'Model Context Protocol'
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(payload, null, 2)
          }
        ]
      };
    }
  );

  server.registerPrompt(
    'tool-call-checklist',
    {
      title: 'Tool Call Checklist',
      description: 'Reusable checklist before invoking an MCP tool',
      argsSchema: {
        toolName: z.string().min(1).describe('Tool name to review')
      }
    },
    ({ toolName }) => {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Before calling ${toolName}, verify input schema, expected output schema, and failure handling.`
            }
          }
        ]
      };
    }
  );

  return server;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
