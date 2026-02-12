import { config as loadDotEnv } from 'dotenv';

export type TransportMode = 'stdio' | 'http';

export interface RuntimeConfig {
  transport: TransportMode;
  http: {
    host: string;
    port: number;
    path: string;
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

  return {
    transport,
    http: {
      host,
      port: parsePort(portValue),
      path: normalizePath(pathValue)
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
