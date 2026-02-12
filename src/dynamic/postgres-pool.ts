import { Pool } from 'pg';

const poolMap = new Map<string, Pool>();

export function getSharedPostgresPool(connectionString: string): Pool {
  const key = connectionString;
  const existing = poolMap.get(key);
  if (existing) {
    return existing;
  }

  const pool = new Pool({ connectionString });
  poolMap.set(key, pool);
  return pool;
}
