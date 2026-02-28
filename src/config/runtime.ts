import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';

export type TransportMode = 'stdio' | 'http';
export type FeatureProfile = 'mvp' | 'enterprise';
export type ExecutionEngineMode = 'auto' | 'docker' | 'node';

export interface RuntimeConfig {
  profile: FeatureProfile;
  transport: TransportMode;
  http: {
    host: string;
    port: number;
    path: string;
    sessionTtlSeconds: number;
    maxRequestBytes: number;
  };
  dynamic: {
    backend: 'file' | 'postgres';
    storeFilePath: string;
    maxTools: number;
    readOnly: boolean;
    requireAdminToken: boolean;
    adminToken?: string;
    postgres?: {
      connectionString: string;
      schema: string;
      initMaxAttempts: number;
      initBackoffMs: number;
    };
  };
  sandbox: {
    executionEngine: ExecutionEngineMode;
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
  audit: {
    enabled: boolean;
    filePath: string;
    maxEventBytes: number;
    maxFileBytes: number;
    maxFiles: number;
  };
}

type ArgMap = Record<string, string>;

export function loadRuntimeConfig(argv = process.argv.slice(2), env = process.env): RuntimeConfig {
  loadDotEnv({ quiet: true });

  const args = parseArgs(argv);
  const profile = parseFeatureProfile(args.profile ?? env.MCP_PROFILE ?? 'mvp');
  const transport = parseTransportMode(args.transport ?? env.MCP_TRANSPORT ?? 'stdio');
  const host = args.host ?? env.MCP_HOST ?? '127.0.0.1';
  const portValue = args.port ?? env.MCP_PORT ?? env.PORT ?? '8788';
  const pathValue = args.path ?? env.MCP_PATH ?? '/mcp';
  const storeFilePath = resolve(
    args['dynamic-store'] ?? env.MCP_DYNAMIC_STORE ?? '.dynamic-mcp/tools.json'
  );
  const dynamicBackend = parseDynamicBackend(args['dynamic-backend'] ?? env.MCP_DYNAMIC_BACKEND ?? 'file');
  const maxTools = parseDynamicToolLimit(
    args['dynamic-max-tools'] ?? env.MCP_DYNAMIC_MAX_TOOLS ?? '256'
  );
  const readOnly = parseBoolean(args['dynamic-read-only'] ?? env.MCP_DYNAMIC_READ_ONLY ?? 'false');
  const auth = loadAuthConfig(args, env);
  const requireAdminToken = parseBoolean(
    args['require-admin-token'] ??
      env.MCP_REQUIRE_ADMIN_TOKEN ??
      (profile === 'enterprise' && transport === 'http' && auth.mode === 'jwt'
        ? 'true'
        : 'false')
  );
  const adminToken = normalizeOptionalString(args['admin-token'] ?? env.MCP_ADMIN_TOKEN);
  const postgresConnectionString = normalizeOptionalString(
    args['dynamic-pg-url'] ?? env.MCP_DYNAMIC_PG_URL
  );
  const postgresSchema =
    normalizeOptionalString(args['dynamic-pg-schema'] ?? env.MCP_DYNAMIC_PG_SCHEMA) ??
    'dynamic_mcp';
  const postgresInitMaxAttempts = parsePositiveInteger(
    args['dynamic-pg-init-max-attempts'] ?? env.MCP_DYNAMIC_PG_INIT_MAX_ATTEMPTS ?? '10',
    'MCP postgres init max attempts',
    100
  );
  const postgresInitBackoffMs = parsePositiveInteger(
    args['dynamic-pg-init-backoff-ms'] ?? env.MCP_DYNAMIC_PG_INIT_BACKOFF_MS ?? '1000',
    'MCP postgres init backoff ms',
    60_000
  );
  const allowedImages = splitCsv(
    args['sandbox-allowed-images'] ?? env.MCP_SANDBOX_ALLOWED_IMAGES ?? 'node:lts-slim'
  );
  const blockedPackages = splitCsv(
    args['sandbox-blocked-packages'] ??
      env.MCP_SANDBOX_BLOCKED_PACKAGES ??
      'child_process,node-pty,npm,pm2'
  );
  const executionEngine = parseExecutionEngineMode(
    args['execution-engine'] ?? env.MCP_EXECUTION_ENGINE ?? 'auto'
  );

  return {
    profile,
    transport,
    http: {
      host,
      port: parsePort(portValue),
      path: normalizePath(pathValue),
      sessionTtlSeconds: parsePositiveInteger(
        args['http-session-ttl-seconds'] ?? env.MCP_HTTP_SESSION_TTL_SECONDS ?? '1800',
        'MCP HTTP session TTL seconds',
        604_800
      ),
      maxRequestBytes: parsePositiveInteger(
        args['http-max-request-bytes'] ?? env.MCP_HTTP_MAX_REQUEST_BYTES ?? '102400',
        'MCP HTTP max request bytes',
        102_400
      )
    },
    dynamic: loadDynamicConfig({
      backend: dynamicBackend,
      storeFilePath,
      maxTools,
      readOnly,
      requireAdminToken,
      adminToken,
      postgresConnectionString,
      postgresSchema,
      postgresInitMaxAttempts,
      postgresInitBackoffMs
    }),
    sandbox: {
      executionEngine,
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
      blockedPackages,
      sessionTimeoutSeconds: parsePositiveInteger(
        args['sandbox-session-timeout-seconds'] ??
          env.MCP_SANDBOX_SESSION_TIMEOUT_SECONDS ??
          '1800',
        'MCP sandbox session timeout seconds',
        172_800
      ),
      maxSessions: parsePositiveInteger(
        args['sandbox-max-sessions'] ?? env.MCP_SANDBOX_MAX_SESSIONS ?? '20',
        'MCP sandbox max sessions',
        1000
      )
    },
    security: {
      toolMaxConcurrency: parsePositiveInteger(
        args['tool-max-concurrency'] ?? env.MCP_TOOL_MAX_CONCURRENCY ?? '8',
        'MCP tool max concurrency',
        10_000
      ),
      toolMaxCallsPerWindow: parsePositiveInteger(
        args['tool-max-calls-per-window'] ?? env.MCP_TOOL_MAX_CALLS_PER_WINDOW ?? '300',
        'MCP tool max calls per window',
        1_000_000
      ),
      toolRateWindowMs: parsePositiveInteger(
        args['tool-rate-window-ms'] ?? env.MCP_TOOL_RATE_WINDOW_MS ?? '60000',
        'MCP tool rate window',
        86_400_000
      )
    },
    auth,
    audit: {
      enabled: parseBoolean(
        args['audit-enabled'] ?? env.MCP_AUDIT_ENABLED ?? (profile === 'enterprise' ? 'true' : 'false')
      ),
      filePath: resolve(args['audit-file'] ?? env.MCP_AUDIT_FILE ?? '.dynamic-mcp/audit.log'),
      maxEventBytes: parsePositiveInteger(
        args['audit-max-event-bytes'] ?? env.MCP_AUDIT_MAX_EVENT_BYTES ?? '20000',
        'MCP audit max event bytes',
        1_000_000
      ),
      maxFileBytes: parsePositiveInteger(
        args['audit-max-file-bytes'] ?? env.MCP_AUDIT_MAX_FILE_BYTES ?? '10000000',
        'MCP audit max file bytes',
        1_000_000_000
      ),
      maxFiles: parsePositiveInteger(
        args['audit-max-files'] ?? env.MCP_AUDIT_MAX_FILES ?? '5',
        'MCP audit max files',
        100
      )
    }
  };
}

function parseFeatureProfile(value: string): FeatureProfile {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'mvp' || normalized === 'enterprise') {
    return normalized;
  }

  throw new Error(`Invalid MCP profile "${value}". Expected "mvp" or "enterprise".`);
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

function parseDynamicBackend(value: string): RuntimeConfig['dynamic']['backend'] {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'file' || normalized === 'postgres') {
    return normalized;
  }

  throw new Error(`Invalid MCP dynamic backend "${value}". Expected "file" or "postgres".`);
}

function parseExecutionEngineMode(value: string): ExecutionEngineMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'docker' || normalized === 'node') {
    return normalized;
  }

  throw new Error(`Invalid MCP execution engine "${value}". Expected "auto", "docker", or "node".`);
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

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value "${value}".`);
}

function loadAuthConfig(args: ArgMap, env: NodeJS.ProcessEnv): RuntimeConfig['auth'] {
  const modeRaw = (args['auth-mode'] ?? env.MCP_AUTH_MODE ?? 'none').trim().toLowerCase();
  if (modeRaw === 'none') {
    return { mode: 'none' };
  }

  if (modeRaw !== 'jwt') {
    throw new Error(`Invalid MCP auth mode "${modeRaw}". Expected "none" or "jwt".`);
  }

  const jwksUrl = normalizeRequiredString(args['auth-jwks-url'] ?? env.MCP_AUTH_JWKS_URL, 'MCP_AUTH_JWKS_URL');
  const issuer = normalizeRequiredString(args['auth-issuer'] ?? env.MCP_AUTH_ISSUER, 'MCP_AUTH_ISSUER');
  const audience = normalizeRequiredString(
    args['auth-audience'] ?? env.MCP_AUTH_AUDIENCE,
    'MCP_AUTH_AUDIENCE'
  );

  const requiredScopes = splitCsv(
    args['auth-required-scopes'] ?? env.MCP_AUTH_REQUIRED_SCOPES ?? ''
  );

  return {
    mode: 'jwt',
    jwt: {
      jwksUrl,
      issuer,
      audience,
      requiredScopes
    }
  };
}

function loadDynamicConfig(params: {
  backend: RuntimeConfig['dynamic']['backend'];
  storeFilePath: string;
  maxTools: number;
  readOnly: boolean;
  requireAdminToken: boolean;
  adminToken?: string;
  postgresConnectionString?: string;
  postgresSchema: string;
  postgresInitMaxAttempts: number;
  postgresInitBackoffMs: number;
}): RuntimeConfig['dynamic'] {
  if (params.requireAdminToken && !params.adminToken) {
    throw new Error('Missing required config: MCP_ADMIN_TOKEN');
  }

  const base = {
    backend: params.backend,
    storeFilePath: params.storeFilePath,
    maxTools: params.maxTools,
    readOnly: params.readOnly,
    requireAdminToken: params.requireAdminToken,
    ...(params.adminToken ? { adminToken: params.adminToken } : {})
  } satisfies Omit<RuntimeConfig['dynamic'], 'postgres'>;

  if (params.backend === 'file') {
    return base;
  }

  const connectionString = normalizeRequiredString(
    params.postgresConnectionString,
    'MCP_DYNAMIC_PG_URL'
  );

  return {
    ...base,
    postgres: {
      connectionString,
      schema: params.postgresSchema,
      initMaxAttempts: params.postgresInitMaxAttempts,
      initBackoffMs: params.postgresInitBackoffMs
    }
  };
}

function normalizeRequiredString(value: string | undefined, key: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required config: ${key}`);
  }

  return value.trim();
}
