import type { DynamicToolCreate, DynamicToolRecord, DynamicToolUpdate } from './spec.js';

export interface DynamicToolRegistryPort {
  load(): Promise<void>;
  reload(): Promise<void>;
  list(): Promise<DynamicToolRecord[]>;
  get(name: string): Promise<DynamicToolRecord | null>;
  create(input: DynamicToolCreate): Promise<DynamicToolRecord>;
  update(
    name: string,
    patch: DynamicToolUpdate,
    expectedRevision?: number
  ): Promise<DynamicToolRecord>;
  remove(name: string, expectedRevision?: number): Promise<boolean>;
  setEnabled(name: string, enabled: boolean, expectedRevision?: number): Promise<DynamicToolRecord>;
}
