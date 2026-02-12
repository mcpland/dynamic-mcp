import { afterEach, describe, expect, it } from 'vitest';

import {
  closeAllSharedPostgresPools,
  getSharedPostgresPool,
  getSharedPostgresPoolCount
} from '../src/dynamic/postgres-pool.js';

afterEach(async () => {
  await closeAllSharedPostgresPools();
});

describe('shared postgres pool', () => {
  it('reuses pool by connection string', () => {
    const first = getSharedPostgresPool('postgres://postgres:postgres@127.0.0.1:5432/a');
    const second = getSharedPostgresPool('postgres://postgres:postgres@127.0.0.1:5432/a');
    const third = getSharedPostgresPool('postgres://postgres:postgres@127.0.0.1:5432/b');

    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(getSharedPostgresPoolCount()).toBe(2);
  });

  it('closes and clears all shared pools', async () => {
    getSharedPostgresPool('postgres://postgres:postgres@127.0.0.1:5432/a');
    getSharedPostgresPool('postgres://postgres:postgres@127.0.0.1:5432/b');
    expect(getSharedPostgresPoolCount()).toBe(2);

    await closeAllSharedPostgresPools();
    expect(getSharedPostgresPoolCount()).toBe(0);
  });
});
