import type { Pool } from 'pg';

import { buildCreatedRecord, buildUpdatedRecord } from './record-utils.js';
import type { DynamicToolRegistryPort } from './registry-port.js';
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
}

export class PostgresDynamicToolRegistry implements DynamicToolRegistryPort {
  private readonly pool: Pool;
  private readonly maxTools: number;
  private readonly schema: string;
  private loaded = false;

  constructor(options: PostgresDynamicToolRegistryOptions) {
    this.pool = options.pool;
    this.maxTools = options.maxTools;
    this.schema = assertValidIdentifier(options.schema);
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

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

  async update(name: string, patch: DynamicToolUpdate): Promise<DynamicToolRecord> {
    this.assertLoaded();

    const existing = await this.get(name);
    if (!existing) {
      throw new Error(`Dynamic tool not found: ${name}`);
    }

    const updated = buildUpdatedRecord(existing, patch);

    await this.pool.query(
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
        updated.revision
      ]
    );

    return updated;
  }

  async remove(name: string): Promise<boolean> {
    this.assertLoaded();

    const result = await this.pool.query(`DELETE FROM ${this.schema}.dynamic_tools WHERE name = $1`, [name]);
    return (result.rowCount ?? 0) > 0;
  }

  async setEnabled(name: string, enabled: boolean): Promise<DynamicToolRecord> {
    return this.update(name, { enabled });
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
