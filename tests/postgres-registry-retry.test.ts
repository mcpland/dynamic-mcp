import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PostgresDynamicToolRegistry } from '../src/dynamic/postgres-registry.js';

describe('PostgresDynamicToolRegistry load retries', () => {
  it('retries transient init errors and recovers', async () => {
    let calls = 0;
    const pool = {
      query: async () => {
        calls += 1;
        if (calls <= 2) {
          throw withCode(new Error('connect ECONNREFUSED'), 'ECONNREFUSED');
        }

        return { rowCount: 1, rows: [] };
      }
    } as unknown as Pool;

    const registry = new PostgresDynamicToolRegistry({
      pool,
      maxTools: 10,
      schema: 'dynamic_mcp',
      initMaxAttempts: 4,
      initBackoffMs: 1
    });

    await registry.load();
    expect(calls).toBe(4);
  });

  it('fails fast on non-retriable init errors', async () => {
    let calls = 0;
    const pool = {
      query: async () => {
        calls += 1;
        throw withCode(new Error('syntax error at or near "BAD"'), '42601');
      }
    } as unknown as Pool;

    const registry = new PostgresDynamicToolRegistry({
      pool,
      maxTools: 10,
      schema: 'dynamic_mcp',
      initMaxAttempts: 5,
      initBackoffMs: 1
    });

    await expect(registry.load()).rejects.toThrow(/syntax error/i);
    expect(calls).toBe(1);
  });

  it('stops after max init retry attempts', async () => {
    let calls = 0;
    const pool = {
      query: async () => {
        calls += 1;
        throw withCode(new Error('connect ECONNREFUSED'), 'ECONNREFUSED');
      }
    } as unknown as Pool;

    const registry = new PostgresDynamicToolRegistry({
      pool,
      maxTools: 10,
      schema: 'dynamic_mcp',
      initMaxAttempts: 3,
      initBackoffMs: 1
    });

    await expect(registry.load()).rejects.toThrow(/ECONNREFUSED/i);
    expect(calls).toBe(3);
  });

  it('uses advisory lock transaction for create maxTools enforcement', async () => {
    const txQueries: string[] = [];
    const release = vi.fn();
    const client = {
      query: async (sql: string) => {
        txQueries.push(sql.trim());
        if (sql.includes('SELECT COUNT(*)::integer AS count')) {
          return { rowCount: 1, rows: [{ count: 0 }] };
        }
        if (sql.includes('INSERT INTO dynamic_mcp.dynamic_tools')) {
          return {
            rowCount: 1,
            rows: [
              {
                name: 'dynamic.locked',
                title: null,
                description: 'x',
                image: 'node:lts-slim',
                timeout_ms: 30_000,
                dependencies: [],
                code: 'return 1;',
                enabled: true,
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z',
                revision: 1
              }
            ]
          };
        }
        return { rowCount: 0, rows: [] };
      },
      release
    };

    const poolQuery = vi.fn(async () => ({ rowCount: 0, rows: [] }));
    const pool = {
      query: poolQuery,
      connect: async () => client
    } as unknown as Pool;

    const registry = new PostgresDynamicToolRegistry({
      pool,
      maxTools: 1,
      schema: 'dynamic_mcp',
      initMaxAttempts: 1,
      initBackoffMs: 1
    });

    await registry.load();
    const created = await registry.create({
      name: 'dynamic.locked',
      description: 'x',
      code: 'return 1;'
    });

    expect(created.name).toBe('dynamic.locked');
    expect(txQueries[0]).toBe('BEGIN');
    expect(txQueries.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(txQueries.at(-1)).toBe('COMMIT');
    expect(poolQuery.mock.calls.some(([sql]) => String(sql).includes('pg_notify'))).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rolls back create transaction when maxTools limit is reached', async () => {
    const txQueries: string[] = [];
    const release = vi.fn();
    const client = {
      query: async (sql: string) => {
        txQueries.push(sql.trim());
        if (sql.includes('SELECT COUNT(*)::integer AS count')) {
          return { rowCount: 1, rows: [{ count: 1 }] };
        }
        return { rowCount: 0, rows: [] };
      },
      release
    };

    const poolQuery = vi.fn(async () => ({ rowCount: 0, rows: [] }));
    const pool = {
      query: poolQuery,
      connect: async () => client
    } as unknown as Pool;

    const registry = new PostgresDynamicToolRegistry({
      pool,
      maxTools: 1,
      schema: 'dynamic_mcp',
      initMaxAttempts: 1,
      initBackoffMs: 1
    });

    await registry.load();
    await expect(
      registry.create({
        name: 'dynamic.over_limit',
        description: 'x',
        code: 'return 1;'
      })
    ).rejects.toThrow(/limit reached/i);

    expect(txQueries).toContain('ROLLBACK');
    expect(txQueries).not.toContain('COMMIT');
    expect(poolQuery.mock.calls.some(([sql]) => String(sql).includes('pg_notify'))).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

function withCode<T extends Error>(error: T, code: string): T & { code: string } {
  return Object.assign(error, { code });
}
