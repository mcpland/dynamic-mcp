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

export async function closeAllSharedPostgresPools(): Promise<void> {
  const pools = [...poolMap.values()];
  poolMap.clear();
  await Promise.all(pools.map((pool) => pool.end()));
}

export function getSharedPostgresPoolCount(): number {
  return poolMap.size;
}
