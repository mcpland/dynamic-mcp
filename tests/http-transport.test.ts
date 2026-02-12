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
        path: '/mcp'
      },
      {
        dynamic: {
          backend: 'file',
          storeFilePath: join(root, 'tools.json'),
          maxTools: 16
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

    const live = await fetch(`http://127.0.0.1:${port}/livez`);
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toMatchObject({ status: 'ok' });

    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ status: 'ready' });
  });

  it('returns not_ready when postgres backend is misconfigured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-http-health-pg-'));
    const port = await getFreePort();
    const handle = await startHttpTransport(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp'
      },
      {
        dynamic: {
          backend: 'postgres',
          storeFilePath: join(root, 'tools.json'),
          maxTools: 16
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
