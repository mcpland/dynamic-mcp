import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { DockerDynamicToolExecutionEngine } from '../dynamic/docker-executor.js';
import { getSharedPostgresPool } from '../dynamic/postgres-pool.js';
import { PostgresDynamicToolRegistry } from '../dynamic/postgres-registry.js';
import { DynamicToolRegistry } from '../dynamic/registry.js';
import type { DynamicToolRegistryPort } from '../dynamic/registry-port.js';
import { DynamicToolService } from '../dynamic/service.js';
import { registerSessionSandboxTools } from '../sandbox/register-session-tools.js';
import { ToolExecutionGuard } from '../security/guard.js';
import type { AuditLogger } from '../audit/logger.js';

const serviceVersion = '0.2.0';

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

const RuntimeConfigOutputSchema = z.object({
  transports: z.array(z.string()),
  dynamic: z.object({
    backend: z.enum(['file', 'postgres']),
    maxTools: z.number().int().positive(),
    readOnly: z.boolean(),
    adminTokenConfigured: z.boolean(),
    postgresSchema: z.string().optional(),
    postgresInitMaxAttempts: z.number().int().positive().optional(),
    postgresInitBackoffMs: z.number().int().positive().optional()
  }),
  auth: z.object({
    mode: z.enum(['none', 'jwt']),
    jwtConfigured: z.boolean(),
    requiredScopes: z.array(z.string())
  }),
  security: z.object({
    toolMaxConcurrency: z.number().int().positive(),
    toolMaxCallsPerWindow: z.number().int().positive(),
    toolRateWindowMs: z.number().int().positive()
  }),
  sandbox: z.object({
    memoryLimit: z.string(),
    cpuLimit: z.string(),
    maxDependencies: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
    maxTimeoutMs: z.number().int().positive(),
    sessionTimeoutSeconds: z.number().int().positive(),
    maxSessions: z.number().int().positive(),
    allowedImagesCount: z.number().int().nonnegative(),
    blockedPackagesCount: z.number().int().nonnegative()
  }),
  audit: z.object({
    enabled: z.boolean()
  })
});

export interface CreateMcpServerOptions {
  dynamic: {
    backend: 'file' | 'postgres';
    storeFilePath: string;
    maxTools: number;
    readOnly: boolean;
    adminToken?: string;
    postgres?: {
      connectionString: string;
      schema: string;
      initMaxAttempts: number;
      initBackoffMs: number;
    };
  };
  sandbox: {
    dockerBinary: string;
    memoryLimit: string;
    cpuLimit: string;
    maxDependencies: number;
    maxOutputBytes: number;
    maxTimeoutMs: number;
    allowedImages: string[];
    blockedPackages: string[];
    sessionTimeoutSeconds: number;
    maxSessions: number;
  };
  security: {
    toolMaxConcurrency: number;
    toolMaxCallsPerWindow: number;
    toolRateWindowMs: number;
  };
  auth: {
    mode: 'none' | 'jwt';
    jwt?: {
      jwksUrl: string;
      issuer: string;
      audience: string;
      requiredScopes: string[];
    };
  };
  auditLogger: AuditLogger;
}

export async function createMcpServer(options: CreateMcpServerOptions): Promise<McpServer> {
  const startedAt = Date.now();
  const runtimeConfigSnapshot = buildRuntimeConfigSnapshot(options);

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
    async (): Promise<CallToolResult> => {
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
    async ({ message, uppercase }): Promise<CallToolResult> => {
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
    async ({ timeZone }): Promise<CallToolResult> => {
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

  server.registerResource(
    'service.runtime_config',
    'dynamic://service/runtime-config',
    {
      title: 'Runtime Config Snapshot',
      description: 'Sanitized runtime config snapshot for operations and debugging',
      mimeType: 'application/json'
    },
    async (uri) => {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(runtimeConfigSnapshot, null, 2)
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

  const registry = buildDynamicToolRegistry(options.dynamic);

  const executionEngine = new DockerDynamicToolExecutionEngine(options.sandbox);
  const executionGuard = new ToolExecutionGuard({
    maxConcurrency: options.security.toolMaxConcurrency,
    maxCallsPerWindow: options.security.toolMaxCallsPerWindow,
    windowMs: options.security.toolRateWindowMs
  });
  const dynamicService = new DynamicToolService({
    server,
    registry,
    executionEngine,
    adminToken: options.dynamic.adminToken,
    readOnly: options.dynamic.readOnly,
    executionGuard,
    auditLogger: options.auditLogger
  });
  await dynamicService.initialize();

  server.registerResource(
    'guard.metrics',
    'dynamic://metrics/guard',
    {
      title: 'Guard Metrics',
      description: 'Runtime metrics for global tool execution guard',
      mimeType: 'application/json'
    },
    async (uri) => {
      const payload = executionGuard.snapshot();
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

  server.registerTool(
    'system.guard_metrics',
    {
      title: 'Guard Metrics',
      description: 'Get guard concurrency/rate-limit counters',
      outputSchema: z.object({
        activeExecutions: z.number().int().nonnegative(),
        limits: z.object({
          maxConcurrency: z.number().int().positive(),
          maxCallsPerWindow: z.number().int().positive(),
          windowMs: z.number().int().positive()
        }),
        scopes: z.array(
          z.object({
            scope: z.string(),
            total: z.number().int().nonnegative(),
            allowed: z.number().int().nonnegative(),
            rejectedRate: z.number().int().nonnegative(),
            rejectedConcurrency: z.number().int().nonnegative(),
            failed: z.number().int().nonnegative()
          })
        )
      })
    },
    async () => {
      const payload = executionGuard.snapshot();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload)
          }
        ],
        structuredContent: payload
      };
    }
  );

  server.registerTool(
    'system.runtime_config',
    {
      title: 'Runtime Config Snapshot',
      description: 'Return sanitized runtime config snapshot',
      outputSchema: RuntimeConfigOutputSchema
    },
    async () => {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(runtimeConfigSnapshot)
          }
        ],
        structuredContent: runtimeConfigSnapshot
      };
    }
  );

  registerSessionSandboxTools(server, {
    dockerBinary: options.sandbox.dockerBinary,
    memoryLimit: options.sandbox.memoryLimit,
    cpuLimit: options.sandbox.cpuLimit,
    maxDependencies: options.sandbox.maxDependencies,
    maxOutputBytes: options.sandbox.maxOutputBytes,
    maxTimeoutMs: options.sandbox.maxTimeoutMs,
    allowedImages: options.sandbox.allowedImages,
    blockedPackages: options.sandbox.blockedPackages,
    sessionTimeoutSeconds: options.sandbox.sessionTimeoutSeconds,
    maxSessions: options.sandbox.maxSessions,
    adminToken: options.dynamic.adminToken,
    executionGuard,
    auditLogger: options.auditLogger
  });

  return server;
}

function buildDynamicToolRegistry(
  dynamic: CreateMcpServerOptions['dynamic']
): DynamicToolRegistryPort {
  if (dynamic.backend === 'postgres') {
    if (!dynamic.postgres) {
      throw new Error('Missing postgres dynamic registry config.');
    }

    return new PostgresDynamicToolRegistry({
      pool: getSharedPostgresPool(dynamic.postgres.connectionString),
      maxTools: dynamic.maxTools,
      schema: dynamic.postgres.schema,
      initMaxAttempts: dynamic.postgres.initMaxAttempts,
      initBackoffMs: dynamic.postgres.initBackoffMs
    });
  }

  return new DynamicToolRegistry({
    filePath: dynamic.storeFilePath,
    maxTools: dynamic.maxTools
  });
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function buildRuntimeConfigSnapshot(
  options: CreateMcpServerOptions
): z.infer<typeof RuntimeConfigOutputSchema> {
  return {
    transports: ['stdio', 'http'],
    dynamic: {
      backend: options.dynamic.backend,
      maxTools: options.dynamic.maxTools,
      readOnly: options.dynamic.readOnly,
      adminTokenConfigured: Boolean(options.dynamic.adminToken),
      ...(options.dynamic.backend === 'postgres' && options.dynamic.postgres
        ? {
            postgresSchema: options.dynamic.postgres.schema,
            postgresInitMaxAttempts: options.dynamic.postgres.initMaxAttempts,
            postgresInitBackoffMs: options.dynamic.postgres.initBackoffMs
          }
        : {})
    },
    auth: {
      mode: options.auth.mode,
      jwtConfigured: options.auth.mode === 'jwt' && Boolean(options.auth.jwt),
      requiredScopes:
        options.auth.mode === 'jwt' && options.auth.jwt
          ? options.auth.jwt.requiredScopes
          : []
    },
    security: {
      toolMaxConcurrency: options.security.toolMaxConcurrency,
      toolMaxCallsPerWindow: options.security.toolMaxCallsPerWindow,
      toolRateWindowMs: options.security.toolRateWindowMs
    },
    sandbox: {
      memoryLimit: options.sandbox.memoryLimit,
      cpuLimit: options.sandbox.cpuLimit,
      maxDependencies: options.sandbox.maxDependencies,
      maxOutputBytes: options.sandbox.maxOutputBytes,
      maxTimeoutMs: options.sandbox.maxTimeoutMs,
      sessionTimeoutSeconds: options.sandbox.sessionTimeoutSeconds,
      maxSessions: options.sandbox.maxSessions,
      allowedImagesCount: options.sandbox.allowedImages.length,
      blockedPackagesCount: options.sandbox.blockedPackages.length
    },
    audit: {
      enabled: options.auditLogger.isEnabled()
    }
  };
}
