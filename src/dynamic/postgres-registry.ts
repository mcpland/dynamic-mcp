import type { Pool } from 'pg';

import { buildCreatedRecord, buildUpdatedRecord } from './record-utils.js';
import type { DynamicToolRegistryPort } from './registry-port.js';
import { retryAsync } from '../lib/retry.js';
import {
  DynamicToolCreateSchema,
  DynamicToolRecordSchema,
  type DynamicToolCreate,
  type DynamicToolRecord,
  type DynamicToolUpdate
} from './spec.js';

export interface PostgresDynamicToolRegistryOptions {
  pool: Pool;
  maxTools: number;
  schema: string;
  initMaxAttempts: number;
  initBackoffMs: number;
}

export class PostgresDynamicToolRegistry implements DynamicToolRegistryPort {
  private readonly pool: Pool;
  private readonly maxTools: number;
  private readonly schema: string;
  private readonly initMaxAttempts: number;
  private readonly initBackoffMs: number;
  private loaded = false;

  constructor(options: PostgresDynamicToolRegistryOptions) {
    this.pool = options.pool;
    this.maxTools = options.maxTools;
    this.schema = assertValidIdentifier(options.schema);
    this.initMaxAttempts = options.initMaxAttempts;
    this.initBackoffMs = options.initBackoffMs;
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    await retryAsync(
      async () => {
        await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS ${this.schema}.dynamic_tools (
            name TEXT PRIMARY KEY,
            title TEXT,
            description TEXT NOT NULL,
            image TEXT NOT NULL,
            timeout_ms INTEGER NOT NULL,
            dependencies JSONB NOT NULL,
            code TEXT NOT NULL,
            enabled BOOLEAN NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            revision INTEGER NOT NULL
          )
        `);
      },
      {
        maxAttempts: this.initMaxAttempts,
        baseDelayMs: this.initBackoffMs,
        shouldRetry: isRetriablePgInitError
      }
    );

    this.loaded = true;
  }

  async list(): Promise<DynamicToolRecord[]> {
    this.assertLoaded();

    const result = await this.pool.query(`SELECT * FROM ${this.schema}.dynamic_tools ORDER BY name ASC`);
    return result.rows.map((row) => rowToRecord(row));
  }

  async get(name: string): Promise<DynamicToolRecord | null> {
    this.assertLoaded();

    const result = await this.pool.query(`SELECT * FROM ${this.schema}.dynamic_tools WHERE name = $1`, [name]);
    if ((result.rowCount ?? 0) === 0) {
      return null;
    }

    return rowToRecord(result.rows[0]);
  }

  async create(input: DynamicToolCreate): Promise<DynamicToolRecord> {
    this.assertLoaded();

    const normalized = DynamicToolCreateSchema.parse(input);
    const existingCount = await this.countTools();
    if (existingCount >= this.maxTools) {
      throw new Error(`Dynamic tool limit reached (${this.maxTools}).`);
    }

    const record = buildCreatedRecord(normalized);

    const result = await this.pool.query(
      `
      INSERT INTO ${this.schema}.dynamic_tools
      (name, title, description, image, timeout_ms, dependencies, code, enabled, created_at, updated_at, revision)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::timestamptz,$10::timestamptz,$11)
      ON CONFLICT (name) DO NOTHING
      RETURNING *
      `,
      [
        record.name,
        record.title ?? null,
        record.description,
        record.image,
        record.timeoutMs,
        JSON.stringify(record.dependencies),
        record.code,
        record.enabled,
        record.createdAt,
        record.updatedAt,
        record.revision
      ]
    );

    if ((result.rowCount ?? 0) !== 1) {
      throw new Error(`Dynamic tool already exists: ${record.name}`);
    }

    return rowToRecord(result.rows[0]);
  }

  async update(
    name: string,
    patch: DynamicToolUpdate,
    expectedRevision?: number
  ): Promise<DynamicToolRecord> {
    this.assertLoaded();

    const existing = await this.get(name);
    if (!existing) {
      throw new Error(`Dynamic tool not found: ${name}`);
    }
    assertExpectedRevision(name, expectedRevision, existing.revision);

    const updated = buildUpdatedRecord(existing, patch);

    const result = await this.pool.query(
      `
      UPDATE ${this.schema}.dynamic_tools
      SET
        title = $2,
        description = $3,
        image = $4,
        timeout_ms = $5,
        dependencies = $6::jsonb,
        code = $7,
        enabled = $8,
        updated_at = $9::timestamptz,
        revision = $10
      WHERE name = $1
        AND revision = $11
      `,
      [
        updated.name,
        updated.title ?? null,
        updated.description,
        updated.image,
        updated.timeoutMs,
        JSON.stringify(updated.dependencies),
        updated.code,
        updated.enabled,
        updated.updatedAt,
        updated.revision,
        existing.revision
      ]
    );

    if ((result.rowCount ?? 0) !== 1) {
      throw await buildRevisionConflictOrNotFound(this.pool, this.schema, name, existing.revision);
    }

    return updated;
  }

  async remove(name: string, expectedRevision?: number): Promise<boolean> {
    this.assertLoaded();

    const existing = await this.get(name);
    if (!existing) {
      return false;
    }
    assertExpectedRevision(name, expectedRevision, existing.revision);

    const result = await this.pool.query(
      `DELETE FROM ${this.schema}.dynamic_tools WHERE name = $1 AND revision = $2`,
      [name, existing.revision]
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw await buildRevisionConflictOrNotFound(this.pool, this.schema, name, existing.revision);
    }

    return (result.rowCount ?? 0) > 0;
  }

  async setEnabled(
    name: string,
    enabled: boolean,
    expectedRevision?: number
  ): Promise<DynamicToolRecord> {
    return this.update(name, { enabled }, expectedRevision);
  }

  private async countTools(): Promise<number> {
    const result = await this.pool.query(`SELECT COUNT(*)::integer AS count FROM ${this.schema}.dynamic_tools`);
    return Number(result.rows[0]?.count ?? 0);
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error('PostgresDynamicToolRegistry not loaded. Call load() first.');
    }
  }
}

function rowToRecord(row: Record<string, unknown>): DynamicToolRecord {
  return DynamicToolRecordSchema.parse({
    name: row.name,
    title: row.title ?? undefined,
    description: row.description,
    image: row.image,
    timeoutMs: row.timeout_ms,
    dependencies: row.dependencies,
    code: row.code,
    enabled: row.enabled,
    createdAt:
      typeof row.created_at === 'string'
        ? row.created_at
        : row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    updatedAt:
      typeof row.updated_at === 'string'
        ? row.updated_at
        : row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : String(row.updated_at),
    revision: row.revision
  });
}

function assertValidIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }

  return value;
}

function assertExpectedRevision(
  name: string,
  expectedRevision: number | undefined,
  currentRevision: number
): void {
  if (expectedRevision === undefined) {
    return;
  }

  if (expectedRevision !== currentRevision) {
    throw new Error(
      `Revision conflict for dynamic tool "${name}": expected ${expectedRevision}, current ${currentRevision}.`
    );
  }
}

async function buildRevisionConflictOrNotFound(
  pool: Pool,
  schema: string,
  name: string,
  previousRevision: number
): Promise<Error> {
  const result = await pool.query(`SELECT revision FROM ${schema}.dynamic_tools WHERE name = $1`, [name]);
  if ((result.rowCount ?? 0) === 0) {
    return new Error(`Dynamic tool not found: ${name}`);
  }

  const currentRevision = Number(result.rows[0]?.revision ?? NaN);
  if (Number.isFinite(currentRevision)) {
    return new Error(
      `Revision conflict for dynamic tool "${name}": expected ${previousRevision}, current ${currentRevision}.`
    );
  }

  return new Error(`Revision conflict for dynamic tool "${name}".`);
}

function isRetriablePgInitError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string') {
    if (retriableSqlState.has(code)) {
      return true;
    }

    if (retriableNodeErrorCodes.has(code)) {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return retriableMessagePatterns.some((pattern) => pattern.test(message));
}

const retriableSqlState = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01'
]);

const retriableNodeErrorCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT'
]);

const retriableMessagePatterns = [
  /connection terminated/i,
  /failed to connect/i,
  /timeout/i
];
