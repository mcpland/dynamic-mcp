import { describe, expect, it } from 'vitest';

import { loadRuntimeConfig } from '../src/config/runtime.js';

describe('loadRuntimeConfig', () => {
  it('uses defaults when no args are provided', () => {
    const config = loadRuntimeConfig([], {});

    expect(config.profile).toBe('mvp');
    expect(config.transport).toBe('stdio');
    expect(config.http.host).toBe('127.0.0.1');
    expect(config.http.port).toBe(8788);
    expect(config.http.path).toBe('/mcp');
    expect(config.http.sessionTtlSeconds).toBe(1800);
    expect(config.http.maxRequestBytes).toBe(102_400);
    expect(config.dynamic.backend).toBe('file');
    expect(config.dynamic.storeFilePath.endsWith('.dynamic-mcp/tools.json')).toBe(true);
    expect(config.dynamic.maxTools).toBe(256);
    expect(config.dynamic.readOnly).toBe(false);
    expect(config.dynamic.requireAdminToken).toBe(false);
    expect(config.sandbox.memoryLimit).toBe('512m');
    expect(config.sandbox.allowedImages).toEqual(['node:lts-slim']);
    expect(config.sandbox.sessionTimeoutSeconds).toBe(1800);
    expect(config.sandbox.maxSessions).toBe(20);
    expect(config.security.toolMaxConcurrency).toBe(8);
    expect(config.security.toolRateWindowMs).toBe(60000);
    expect(config.auth.mode).toBe('none');
    expect(config.audit.enabled).toBe(false);
    expect(config.audit.filePath.endsWith('.dynamic-mcp/audit.log')).toBe(true);
    expect(config.audit.maxFileBytes).toBe(10_000_000);
    expect(config.audit.maxFiles).toBe(5);
  });

  it('reads CLI flags and normalizes path', () => {
    const config = loadRuntimeConfig(
      [
        '--profile',
        'enterprise',
        '--transport',
        'http',
        '--path',
        'gateway',
        '--http-session-ttl-seconds',
        '90',
        '--http-max-request-bytes',
        '2048',
        '--dynamic-max-tools',
        '12',
        '--admin-token',
        'secret-token',
        '--sandbox-allowed-images',
        'node:lts-slim,node:22-alpine'
      ],
      {}
    );

    expect(config.transport).toBe('http');
    expect(config.profile).toBe('enterprise');
    expect(config.http.path).toBe('/gateway');
    expect(config.http.sessionTtlSeconds).toBe(90);
    expect(config.http.maxRequestBytes).toBe(2048);
    expect(config.dynamic.backend).toBe('file');
    expect(config.dynamic.maxTools).toBe(12);
    expect(config.dynamic.readOnly).toBe(false);
    expect(config.dynamic.requireAdminToken).toBe(false);
    expect(config.dynamic.adminToken).toBe('secret-token');
    expect(config.sandbox.allowedImages).toEqual(['node:lts-slim', 'node:22-alpine']);
    expect(config.audit.enabled).toBe(true);
  });

  it('rejects invalid transport', () => {
    expect(() => loadRuntimeConfig(['--transport', 'bad'], {})).toThrow(
      /Unsupported transport/
    );
  });

  it('loads jwt auth mode config', () => {
    const config = loadRuntimeConfig(
      ['--auth-mode', 'jwt', '--auth-jwks-url', 'https://issuer/jwks', '--auth-issuer', 'https://issuer', '--auth-audience', 'dynamic-mcp'],
      {}
    );

    expect(config.auth.mode).toBe('jwt');
    if (config.auth.mode !== 'jwt') {
      throw new Error('Expected jwt mode');
    }

    expect(config.auth.jwt?.jwksUrl).toBe('https://issuer/jwks');
    expect(config.auth.jwt?.issuer).toBe('https://issuer');
    expect(config.auth.jwt?.audience).toBe('dynamic-mcp');
  });

  it('loads postgres dynamic backend config', () => {
    const config = loadRuntimeConfig(
      [
        '--dynamic-backend',
        'postgres',
        '--dynamic-pg-url',
        'postgres://postgres:postgres@localhost:5432/dynamic_mcp',
        '--dynamic-pg-schema',
        'mcp_runtime'
      ],
      {}
    );

    expect(config.dynamic.backend).toBe('postgres');
    expect(config.dynamic.postgres?.connectionString).toBe(
      'postgres://postgres:postgres@localhost:5432/dynamic_mcp'
    );
    expect(config.dynamic.postgres?.schema).toBe('mcp_runtime');
    expect(config.dynamic.postgres?.initMaxAttempts).toBe(10);
    expect(config.dynamic.postgres?.initBackoffMs).toBe(1000);
  });

  it('requires postgres URL when postgres backend is selected', () => {
    expect(() => loadRuntimeConfig(['--dynamic-backend', 'postgres'], {})).toThrow(
      /MCP_DYNAMIC_PG_URL/
    );
  });

  it('loads postgres init retry settings', () => {
    const config = loadRuntimeConfig(
      [
        '--dynamic-backend',
        'postgres',
        '--dynamic-pg-url',
        'postgres://postgres:postgres@localhost:5432/dynamic_mcp',
        '--dynamic-pg-init-max-attempts',
        '4',
        '--dynamic-pg-init-backoff-ms',
        '25'
      ],
      {}
    );

    expect(config.dynamic.postgres?.initMaxAttempts).toBe(4);
    expect(config.dynamic.postgres?.initBackoffMs).toBe(25);
  });

  it('loads dynamic read-only mode', () => {
    const config = loadRuntimeConfig(['--dynamic-read-only', 'true'], {});
    expect(config.dynamic.readOnly).toBe(true);
  });

  it('requires MCP_ADMIN_TOKEN when require-admin-token is enabled', () => {
    expect(() => loadRuntimeConfig(['--require-admin-token', 'true'], {})).toThrow(
      /MCP_ADMIN_TOKEN/
    );
  });

  it('enables admin-token requirement by default for enterprise http jwt mode', () => {
    expect(() =>
      loadRuntimeConfig(
        [
          '--profile',
          'enterprise',
          '--transport',
          'http',
          '--auth-mode',
          'jwt',
          '--auth-jwks-url',
          'https://issuer/jwks',
          '--auth-issuer',
          'https://issuer',
          '--auth-audience',
          'dynamic-mcp'
        ],
        {}
      )
    ).toThrow(/MCP_ADMIN_TOKEN/);
  });

  it('allows disabling admin-token requirement explicitly', () => {
    const config = loadRuntimeConfig(
      [
        '--profile',
        'enterprise',
        '--transport',
        'http',
        '--auth-mode',
        'jwt',
        '--auth-jwks-url',
        'https://issuer/jwks',
        '--auth-issuer',
        'https://issuer',
        '--auth-audience',
        'dynamic-mcp',
        '--require-admin-token',
        'false'
      ],
      {}
    );

    expect(config.dynamic.requireAdminToken).toBe(false);
  });

  it('loads audit rotation config values', () => {
    const config = loadRuntimeConfig(
      ['--audit-max-file-bytes', '2048', '--audit-max-files', '7'],
      {}
    );

    expect(config.audit.maxFileBytes).toBe(2048);
    expect(config.audit.maxFiles).toBe(7);
  });

  it('rejects invalid profile', () => {
    expect(() => loadRuntimeConfig(['--profile', 'invalid'], {})).toThrow(
      /Invalid MCP profile/
    );
  });

  it('rejects invalid port value', () => {
    expect(() => loadRuntimeConfig(['--port', '99999'], {})).toThrow(
      /Invalid MCP port/
    );
    expect(() => loadRuntimeConfig(['--port', '0'], {})).toThrow(
      /Invalid MCP port/
    );
    expect(() => loadRuntimeConfig(['--port', 'abc'], {})).toThrow(
      /Invalid MCP port/
    );
  });

  it('rejects invalid dynamic backend', () => {
    expect(() => loadRuntimeConfig(['--dynamic-backend', 'redis'], {})).toThrow(
      /Invalid MCP dynamic backend/
    );
  });

  it('rejects invalid auth mode', () => {
    expect(() => loadRuntimeConfig(['--auth-mode', 'oauth2'], {})).toThrow(
      /Invalid MCP auth mode/
    );
  });

  it('requires jwks url, issuer, audience for jwt auth', () => {
    expect(() => loadRuntimeConfig(['--auth-mode', 'jwt'], {})).toThrow(
      /MCP_AUTH_JWKS_URL/
    );

    expect(() =>
      loadRuntimeConfig(
        ['--auth-mode', 'jwt', '--auth-jwks-url', 'https://example.com/jwks'],
        {}
      )
    ).toThrow(/MCP_AUTH_ISSUER/);

    expect(() =>
      loadRuntimeConfig(
        [
          '--auth-mode',
          'jwt',
          '--auth-jwks-url',
          'https://example.com/jwks',
          '--auth-issuer',
          'https://example.com'
        ],
        {}
      )
    ).toThrow(/MCP_AUTH_AUDIENCE/);
  });

  it('parses boolean values correctly', () => {
    expect(loadRuntimeConfig(['--dynamic-read-only', 'true'], {}).dynamic.readOnly).toBe(
      true
    );
    expect(loadRuntimeConfig(['--dynamic-read-only', '1'], {}).dynamic.readOnly).toBe(
      true
    );
    expect(loadRuntimeConfig(['--dynamic-read-only', 'yes'], {}).dynamic.readOnly).toBe(
      true
    );
    expect(loadRuntimeConfig(['--dynamic-read-only', 'on'], {}).dynamic.readOnly).toBe(
      true
    );
    expect(loadRuntimeConfig(['--dynamic-read-only', 'false'], {}).dynamic.readOnly).toBe(
      false
    );
    expect(loadRuntimeConfig(['--dynamic-read-only', '0'], {}).dynamic.readOnly).toBe(
      false
    );
    expect(loadRuntimeConfig(['--dynamic-read-only', 'no'], {}).dynamic.readOnly).toBe(
      false
    );
    expect(loadRuntimeConfig(['--dynamic-read-only', 'off'], {}).dynamic.readOnly).toBe(
      false
    );
  });

  it('rejects invalid boolean values', () => {
    expect(() => loadRuntimeConfig(['--dynamic-read-only', 'maybe'], {})).toThrow(
      /Invalid boolean/
    );
  });

  it('reads from env vars when no CLI args provided', () => {
    const config = loadRuntimeConfig([], {
      MCP_PROFILE: 'enterprise',
      MCP_TRANSPORT: 'http',
      MCP_HOST: '0.0.0.0',
      MCP_PORT: '3000',
      MCP_PATH: '/api/mcp'
    });

    expect(config.profile).toBe('enterprise');
    expect(config.transport).toBe('http');
    expect(config.http.host).toBe('0.0.0.0');
    expect(config.http.port).toBe(3000);
    expect(config.http.path).toBe('/api/mcp');
  });

  it('CLI args take precedence over env vars', () => {
    const config = loadRuntimeConfig(['--profile', 'mvp'], {
      MCP_PROFILE: 'enterprise'
    });

    expect(config.profile).toBe('mvp');
  });

  it('parses --key=value style CLI arguments', () => {
    const config = loadRuntimeConfig(
      ['--profile=enterprise', '--transport=http', '--port=9999'],
      {}
    );

    expect(config.profile).toBe('enterprise');
    expect(config.transport).toBe('http');
    expect(config.http.port).toBe(9999);
  });

  it('normalizes path by prepending / if missing', () => {
    const config = loadRuntimeConfig(['--path', 'api/mcp'], {});
    expect(config.http.path).toBe('/api/mcp');
  });

  it('path of / stays as /', () => {
    const config = loadRuntimeConfig(['--path', '/'], {});
    expect(config.http.path).toBe('/');
  });

  it('loads sandbox configuration from env vars', () => {
    const config = loadRuntimeConfig([], {
      MCP_SANDBOX_DOCKER_BIN: '/usr/local/bin/docker',
      MCP_SANDBOX_MEMORY_LIMIT: '256m',
      MCP_SANDBOX_CPU_LIMIT: '0.5',
      MCP_SANDBOX_MAX_DEPENDENCIES: '16',
      MCP_SANDBOX_MAX_OUTPUT_BYTES: '100000',
      MCP_SANDBOX_MAX_TIMEOUT_MS: '30000',
      MCP_SANDBOX_SESSION_TIMEOUT_SECONDS: '3600',
      MCP_SANDBOX_MAX_SESSIONS: '50'
    });

    expect(config.sandbox.dockerBinary).toBe('/usr/local/bin/docker');
    expect(config.sandbox.memoryLimit).toBe('256m');
    expect(config.sandbox.cpuLimit).toBe('0.5');
    expect(config.sandbox.maxDependencies).toBe(16);
    expect(config.sandbox.maxOutputBytes).toBe(100_000);
    expect(config.sandbox.maxTimeoutMs).toBe(30_000);
    expect(config.sandbox.sessionTimeoutSeconds).toBe(3600);
    expect(config.sandbox.maxSessions).toBe(50);
  });

  it('loads security config from env vars', () => {
    const config = loadRuntimeConfig([], {
      MCP_TOOL_MAX_CONCURRENCY: '16',
      MCP_TOOL_MAX_CALLS_PER_WINDOW: '500',
      MCP_TOOL_RATE_WINDOW_MS: '30000'
    });

    expect(config.security.toolMaxConcurrency).toBe(16);
    expect(config.security.toolMaxCallsPerWindow).toBe(500);
    expect(config.security.toolRateWindowMs).toBe(30_000);
  });

  it('loads blocked packages from comma-separated env var', () => {
    const config = loadRuntimeConfig([], {
      MCP_SANDBOX_BLOCKED_PACKAGES: 'pkg-a,pkg-b,pkg-c'
    });

    expect(config.sandbox.blockedPackages).toEqual(['pkg-a', 'pkg-b', 'pkg-c']);
  });

  it('handles empty string in allowed images by filtering it out', () => {
    // When an empty string is passed, splitCsv filters out empty entries
    // But parseArgs sees '' as empty value and skips it, so the next arg is consumed
    // resulting in fallback behavior. So test the actual CSV splitting behavior instead:
    const config = loadRuntimeConfig([], {
      MCP_SANDBOX_ALLOWED_IMAGES: ''
    });
    expect(config.sandbox.allowedImages).toEqual([]);
  });

  it('rejects dynamic max tools out of range', () => {
    expect(() => loadRuntimeConfig(['--dynamic-max-tools', '0'], {})).toThrow(
      /Invalid MCP dynamic max tool limit/
    );
    expect(() => loadRuntimeConfig(['--dynamic-max-tools', '20000'], {})).toThrow(
      /Invalid MCP dynamic max tool limit/
    );
  });

  it('enterprise profile defaults audit enabled to true', () => {
    const config = loadRuntimeConfig(['--profile', 'enterprise'], {});
    expect(config.audit.enabled).toBe(true);
  });

  it('mvp profile defaults audit enabled to false', () => {
    const config = loadRuntimeConfig(['--profile', 'mvp'], {});
    expect(config.audit.enabled).toBe(false);
  });

  it('audit can be explicitly overridden via env', () => {
    const config = loadRuntimeConfig([], {
      MCP_PROFILE: 'mvp',
      MCP_AUDIT_ENABLED: 'true'
    });
    expect(config.audit.enabled).toBe(true);
  });

  it('loads jwt auth with required scopes', () => {
    const config = loadRuntimeConfig(
      [
        '--auth-mode',
        'jwt',
        '--auth-jwks-url',
        'https://issuer/jwks',
        '--auth-issuer',
        'https://issuer',
        '--auth-audience',
        'my-api',
        '--auth-required-scopes',
        'read,write,admin'
      ],
      {}
    );

    expect(config.auth.jwt?.requiredScopes).toEqual(['read', 'write', 'admin']);
  });

  it('ignores unknown CLI flags gracefully', () => {
    const config = loadRuntimeConfig(['--unknown-flag', 'value'], {});
    expect(config.profile).toBe('mvp');
  });

  it('handles PORT env var as fallback for MCP_PORT', () => {
    const config = loadRuntimeConfig([], { PORT: '4000' });
    expect(config.http.port).toBe(4000);
  });

  it('MCP_PORT takes precedence over PORT', () => {
    const config = loadRuntimeConfig([], {
      MCP_PORT: '5000',
      PORT: '4000'
    });
    expect(config.http.port).toBe(5000);
  });
});
