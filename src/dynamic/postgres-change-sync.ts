import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { publishDynamicRegistryChange } from './change-bus.js';
import { getSharedPostgresPool } from './postgres-pool.js';

type DynamicRegistryAction = 'create' | 'update' | 'delete' | 'enable' | 'disable';

interface PostgresChangePayload {
  action: DynamicRegistryAction;
  target?: string;
  schema: string;
  instanceId: string;
}

interface ListenerState {
  pool: Pool;
  schema: string;
  client?: PoolClient;
  startPromise?: Promise<void>;
}

const postgresChangeChannel = 'dynamic_mcp_registry_changes';
const localInstanceId = randomUUID();
const listenerStateByKey = new Map<string, ListenerState>();
const allowedActions = new Set<DynamicRegistryAction>([
  'create',
  'update',
  'delete',
  'enable',
  'disable'
]);

export async function ensurePostgresRegistryChangeListener(
  connectionString: string,
  schema: string
): Promise<void> {
  const key = `${connectionString}::${schema}`;
  const existing = listenerStateByKey.get(key);
  if (existing?.startPromise) {
    await existing.startPromise;
    return;
  }

  const state: ListenerState = {
    pool: getSharedPostgresPool(connectionString),
    schema
  };
  listenerStateByKey.set(key, state);

  const startPromise = startListener(state).catch((error) => {
    listenerStateByKey.delete(key);
    throw error;
  });
  state.startPromise = startPromise;
  await startPromise;
}

export async function emitPostgresRegistryChange(
  pool: Pool,
  schema: string,
  action: DynamicRegistryAction,
  target?: string
): Promise<void> {
  const payload: PostgresChangePayload = {
    action,
    target,
    schema,
    instanceId: localInstanceId
  };

  try {
    await pool.query('SELECT pg_notify($1, $2)', [
      postgresChangeChannel,
      JSON.stringify(payload)
    ]);
  } catch {
    // Registry writes must not fail due to sync-notification errors.
  }
}

export async function shutdownPostgresRegistryChangeListeners(): Promise<void> {
  const states = [...listenerStateByKey.values()];
  listenerStateByKey.clear();

  await Promise.all(
    states.map(async (state) => {
      if (state.startPromise) {
        await state.startPromise.catch(() => undefined);
      }

      const client = state.client;
      if (!client) {
        return;
      }

      state.client = undefined;
      try {
        await client.query(`UNLISTEN ${postgresChangeChannel}`);
      } catch {
        // Ignore teardown errors.
      }
      client.removeAllListeners('notification');
      client.removeAllListeners('error');
      client.release();
    })
  );
}

async function startListener(state: ListenerState): Promise<void> {
  const client = await state.pool.connect();
  state.client = client;

  client.on('notification', (message) => {
    handleNotification(state.schema, message.payload);
  });
  client.on('error', () => {
    // Pool lifecycle/shutdown handles reconnect semantics.
  });

  await client.query(`LISTEN ${postgresChangeChannel}`);
}

function handleNotification(expectedSchema: string, rawPayload: string | undefined): void {
  if (!rawPayload) {
    return;
  }

  let payload: Partial<PostgresChangePayload>;
  try {
    payload = JSON.parse(rawPayload) as Partial<PostgresChangePayload>;
  } catch {
    return;
  }

  if (payload.schema !== expectedSchema) {
    return;
  }

  if (!payload.action || !allowedActions.has(payload.action)) {
    return;
  }

  if (payload.instanceId === localInstanceId) {
    return;
  }

  publishDynamicRegistryChange({
    originId: `postgres:${payload.instanceId ?? 'unknown'}`,
    action: payload.action,
    target: typeof payload.target === 'string' ? payload.target : undefined
  });
}
