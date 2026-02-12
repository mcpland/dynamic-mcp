import {
  DynamicToolCreateSchema,
  DynamicToolRecordSchema,
  DynamicToolUpdateSchema,
  type DynamicToolCreate,
  type DynamicToolRecord,
  type DynamicToolUpdate
} from './spec.js';

export function buildCreatedRecord(input: DynamicToolCreate): DynamicToolRecord {
  const normalized = DynamicToolCreateSchema.parse(input);
  const now = new Date().toISOString();

  return DynamicToolRecordSchema.parse({
    ...normalized,
    createdAt: now,
    updatedAt: now,
    revision: 1
  });
}

export function buildUpdatedRecord(
  existing: DynamicToolRecord,
  patch: DynamicToolUpdate
): DynamicToolRecord {
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

  return DynamicToolRecordSchema.parse({
    ...mergedBase,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
    revision: existing.revision + 1
  });
}
