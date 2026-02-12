import type { DynamicToolCreate, DynamicToolRecord, DynamicToolUpdate } from './spec.js';

export interface DynamicToolRegistryPort {
  load(): Promise<void>;
  list(): Promise<DynamicToolRecord[]>;
  get(name: string): Promise<DynamicToolRecord | null>;
  create(input: DynamicToolCreate): Promise<DynamicToolRecord>;
  update(name: string, patch: DynamicToolUpdate): Promise<DynamicToolRecord>;
  remove(name: string): Promise<boolean>;
  setEnabled(name: string, enabled: boolean): Promise<DynamicToolRecord>;
}
