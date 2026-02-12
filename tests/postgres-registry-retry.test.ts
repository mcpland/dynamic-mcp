import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

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
});

function withCode<T extends Error>(error: T, code: string): T & { code: string } {
  return Object.assign(error, { code });
}
