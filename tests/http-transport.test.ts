import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AuditLogger } from '../src/audit/logger.js';
import { startHttpTransport } from '../src/transports/http.js';

const openHandles: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  while (openHandles.length > 0) {
    const handle = openHandles.pop();
    if (handle) {
      await handle.stop();
    }
  }
});

describe('http transport health probes', () => {
  it('exposes livez and readyz as healthy on file backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-http-health-file-'));
    const port = await getFreePort();
    const handle = await startHttpTransport(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        sessionTtlSeconds: 1800,
        maxRequestBytes: 1_000_000
      },
      {
        profile: 'mvp',
        dynamic: {
          backend: 'file',
          storeFilePath: join(root, 'tools.json'),
          maxTools: 16,
          readOnly: false
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
        auth: {
          mode: 'none'
        },
        auditLogger: createTestAuditLogger()
      }
    );
    openHandles.push(handle);

    const live = await fetch(`http://127.0.0.1:${port}/livez`, {
      headers: {
        'x-request-id': 'req-live-1'
      }
    });
    expect(live.status).toBe(200);
    expect(live.headers.get('x-request-id')).toBe('req-live-1');
    expect(live.headers.get('x-content-type-options')).toBe('nosniff');
    expect(live.headers.get('x-frame-options')).toBe('DENY');
    expect(live.headers.get('referrer-policy')).toBe('no-referrer');
    await expect(live.json()).resolves.toMatchObject({ status: 'ok' });

    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.status).toBe(200);
    expect(ready.headers.get('x-request-id')).toBeTruthy();
    await expect(ready.json()).resolves.toMatchObject({ status: 'ready' });
  });

  it('returns not_ready when postgres backend is misconfigured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-http-health-pg-'));
    const port = await getFreePort();
    const handle = await startHttpTransport(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        sessionTtlSeconds: 1800,
        maxRequestBytes: 1_000_000
      },
      {
        profile: 'mvp',
        dynamic: {
          backend: 'postgres',
          storeFilePath: join(root, 'tools.json'),
          maxTools: 16,
          readOnly: false
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
        auth: {
          mode: 'none'
        },
        auditLogger: createTestAuditLogger()
      }
    );
    openHandles.push(handle);

    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toMatchObject({
      status: 'not_ready'
    });
  });

  it('exposes prometheus metrics endpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-http-metrics-'));
    const port = await getFreePort();
    const handle = await startHttpTransport(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        sessionTtlSeconds: 1800,
        maxRequestBytes: 1_000_000
      },
      {
        profile: 'mvp',
        dynamic: {
          backend: 'file',
          storeFilePath: join(root, 'tools.json'),
          maxTools: 16,
          readOnly: false
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
        auth: {
          mode: 'none'
        },
        auditLogger: createTestAuditLogger()
      }
    );
    openHandles.push(handle);

    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(metrics.status).toBe(200);
    const text = await metrics.text();
    expect(text).toContain('dynamic_mcp_process_uptime_seconds');
    expect(text).toContain('dynamic_mcp_http_sessions_active');
    expect(text).toContain('dynamic_mcp_http_sessions_created_total');
    expect(text).toContain('dynamic_mcp_http_sessions_expired_total');
    expect(text).toContain('dynamic_mcp_http_auth_success_total');
    expect(text).toContain('dynamic_mcp_http_auth_denied_total');
  });

  it('rejects oversized request bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-http-body-limit-'));
    const port = await getFreePort();
    const handle = await startHttpTransport(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        sessionTtlSeconds: 1800,
        maxRequestBytes: 64
      },
      {
        profile: 'mvp',
        dynamic: {
          backend: 'file',
          storeFilePath: join(root, 'tools.json'),
          maxTools: 16,
          readOnly: false
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
        auth: {
          mode: 'none'
        },
        auditLogger: createTestAuditLogger()
      }
    );
    openHandles.push(handle);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        payload: 'x'.repeat(400)
      })
    });

    expect(response.status).toBe(413);
    const body = (await response.json()) as {
      error?: {
        message?: string;
      };
    };
    expect(body.error?.message).toMatch(/too large/i);
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

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a test port.'));
        return;
      }

      const port = address.port;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(port);
      });
    });
  });
}
