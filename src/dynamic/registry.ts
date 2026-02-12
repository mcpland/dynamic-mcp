import {
  DynamicToolCreateSchema,
  DynamicToolRecordSchema,
  DynamicToolStoreFileSchema,
  DynamicToolUpdateSchema,
  type DynamicToolCreate,
  type DynamicToolRecord,
  type DynamicToolUpdate
} from './spec.js';
import { readJsonFile, writeJsonFileAtomic } from '../lib/json-file.js';

export interface DynamicToolRegistryOptions {
  filePath: string;
  maxTools: number;
}

export class DynamicToolRegistry {
  private readonly filePath: string;
  private readonly maxTools: number;
  private readonly records = new Map<string, DynamicToolRecord>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: DynamicToolRegistryOptions) {
    this.filePath = options.filePath;
    this.maxTools = options.maxTools;
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const payload = await readJsonFile<unknown>(this.filePath);
    if (!payload) {
      await this.persist();
      this.loaded = true;
      return;
    }

    const parsed = DynamicToolStoreFileSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid dynamic tool store format: ${parsed.error.message}`);
    }

    this.records.clear();
    for (const record of parsed.data.tools) {
      if (this.records.has(record.name)) {
        throw new Error(`Duplicate dynamic tool name found in store: ${record.name}`);
      }

      this.records.set(record.name, record);
    }

    this.loaded = true;
  }

  list(): DynamicToolRecord[] {
    this.assertLoaded();
    return [...this.records.values()]
      .map((record) => structuredClone(record))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): DynamicToolRecord | null {
    this.assertLoaded();
    const record = this.records.get(name);
    return record ? structuredClone(record) : null;
  }

  async create(input: DynamicToolCreate): Promise<DynamicToolRecord> {
    this.assertLoaded();

    const normalized = DynamicToolCreateSchema.parse(input);

    if (this.records.has(normalized.name)) {
      throw new Error(`Dynamic tool already exists: ${normalized.name}`);
    }

    if (this.records.size >= this.maxTools) {
      throw new Error(`Dynamic tool limit reached (${this.maxTools}).`);
    }

    const now = new Date().toISOString();
    const record = DynamicToolRecordSchema.parse({
      ...normalized,
      createdAt: now,
      updatedAt: now,
      revision: 1
    });

    this.records.set(record.name, record);
    await this.persist();

    return structuredClone(record);
  }

  async update(name: string, patch: DynamicToolUpdate): Promise<DynamicToolRecord> {
    this.assertLoaded();

    const existing = this.records.get(name);
    if (!existing) {
      throw new Error(`Dynamic tool not found: ${name}`);
    }

    const normalizedPatch = DynamicToolUpdateSchema.parse(patch);
    const mergedBase = DynamicToolCreateSchema.parse({
      name: existing.name,
      title: normalizedPatch.title ?? existing.title,
      description: normalizedPatch.description ?? existing.description,
      image: normalizedPatch.image ?? existing.image,
      timeoutMs: normalizedPatch.timeoutMs ?? existing.timeoutMs,
      dependencies: normalizedPatch.dependencies ?? existing.dependencies,
      code: normalizedPatch.code ?? existing.code,
      enabled: normalizedPatch.enabled ?? existing.enabled
    });

    const updated = DynamicToolRecordSchema.parse({
      ...mergedBase,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
      revision: existing.revision + 1
    });

    this.records.set(name, updated);
    await this.persist();

    return structuredClone(updated);
  }

  async remove(name: string): Promise<boolean> {
    this.assertLoaded();

    const existed = this.records.delete(name);
    if (!existed) {
      return false;
    }

    await this.persist();
    return true;
  }

  async setEnabled(name: string, enabled: boolean): Promise<DynamicToolRecord> {
    return this.update(name, { enabled });
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error('DynamicToolRegistry not loaded. Call load() first.');
    }
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const payload = {
        version: 1 as const,
        tools: [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name))
      };

      await writeJsonFileAtomic(this.filePath, payload);
    });

    await this.writeChain;
  }
}
