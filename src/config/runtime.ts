import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';

export type TransportMode = 'stdio' | 'http';

export interface RuntimeConfig {
  transport: TransportMode;
  http: {
    host: string;
    port: number;
    path: string;
  };
  dynamic: {
    storeFilePath: string;
    maxTools: number;
    adminToken?: string;
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
  };
}

type ArgMap = Record<string, string>;

export function loadRuntimeConfig(argv = process.argv.slice(2), env = process.env): RuntimeConfig {
  loadDotEnv({ quiet: true });

  const args = parseArgs(argv);
  const transport = parseTransportMode(args.transport ?? env.MCP_TRANSPORT ?? 'stdio');
  const host = args.host ?? env.MCP_HOST ?? '127.0.0.1';
  const portValue = args.port ?? env.MCP_PORT ?? env.PORT ?? '8788';
  const pathValue = args.path ?? env.MCP_PATH ?? '/mcp';
  const storeFilePath = resolve(
    args['dynamic-store'] ?? env.MCP_DYNAMIC_STORE ?? '.dynamic-mcp/tools.json'
  );
  const maxTools = parseDynamicToolLimit(
    args['dynamic-max-tools'] ?? env.MCP_DYNAMIC_MAX_TOOLS ?? '256'
  );
  const adminToken = normalizeOptionalString(args['admin-token'] ?? env.MCP_ADMIN_TOKEN);
  const allowedImages = splitCsv(
    args['sandbox-allowed-images'] ?? env.MCP_SANDBOX_ALLOWED_IMAGES ?? 'node:lts-slim'
  );
  const blockedPackages = splitCsv(
    args['sandbox-blocked-packages'] ??
      env.MCP_SANDBOX_BLOCKED_PACKAGES ??
      'child_process,node-pty,npm,pm2'
  );

  return {
    transport,
    http: {
      host,
      port: parsePort(portValue),
      path: normalizePath(pathValue)
    },
    dynamic: {
      storeFilePath,
      maxTools,
      ...(adminToken ? { adminToken } : {})
    },
    sandbox: {
      dockerBinary: args['docker-bin'] ?? env.MCP_SANDBOX_DOCKER_BIN ?? 'docker',
      memoryLimit: args['sandbox-memory'] ?? env.MCP_SANDBOX_MEMORY_LIMIT ?? '512m',
      cpuLimit: args['sandbox-cpu'] ?? env.MCP_SANDBOX_CPU_LIMIT ?? '1',
      maxDependencies: parsePositiveInteger(
        args['sandbox-max-dependencies'] ?? env.MCP_SANDBOX_MAX_DEPENDENCIES ?? '32',
        'MCP sandbox max dependencies',
        256
      ),
      maxOutputBytes: parsePositiveInteger(
        args['sandbox-max-output-bytes'] ?? env.MCP_SANDBOX_MAX_OUTPUT_BYTES ?? '200000',
        'MCP sandbox max output bytes',
        10_000_000
      ),
      maxTimeoutMs: parsePositiveInteger(
        args['sandbox-max-timeout-ms'] ?? env.MCP_SANDBOX_MAX_TIMEOUT_MS ?? '120000',
        'MCP sandbox max timeout',
        300_000
      ),
      allowedImages,
      blockedPackages
    }
  };
}

function parseArgs(argv: string[]): ArgMap {
  const args: ArgMap = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token || !token.startsWith('--')) {
      continue;
    }

    const withoutPrefix = token.slice(2);
    const eqIndex = withoutPrefix.indexOf('=');
    if (eqIndex > -1) {
      const key = withoutPrefix.slice(0, eqIndex);
      const value = withoutPrefix.slice(eqIndex + 1);
      if (key.length > 0 && value.length > 0) {
        args[key] = value;
      }
      continue;
    }

    const maybeValue = argv[i + 1];
    if (maybeValue && !maybeValue.startsWith('--')) {
      args[withoutPrefix] = maybeValue;
      i += 1;
      continue;
    }

    args[withoutPrefix] = 'true';
  }

  return args;
}

function parseTransportMode(value: string): TransportMode {
  if (value === 'stdio' || value === 'http') {
    return value;
  }

  throw new Error(`Unsupported transport "${value}". Expected "stdio" or "http".`);
}

function parsePort(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid MCP port "${value}". Expected an integer between 1 and 65535.`);
  }

  return parsed;
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('MCP path must not be empty.');
  }

  if (trimmed === '/') {
    return trimmed;
  }

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function parseDynamicToolLimit(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error(`Invalid MCP dynamic max tool limit "${value}". Expected 1-10000.`);
  }

  return parsed;
}

function parsePositiveInteger(value: string, label: string, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`Invalid ${label} "${value}". Expected 1-${max}.`);
  }

  return parsed;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
