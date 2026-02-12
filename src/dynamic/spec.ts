import { z } from 'zod';

export const npmPackageNameRegex = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
export const dynamicToolNameRegex = /^[a-zA-Z][a-zA-Z0-9._:-]{2,63}$/;

export const DynamicDependencySchema = z.object({
  name: z.string().regex(npmPackageNameRegex, 'Invalid npm package name'),
  version: z.string().min(1).max(128)
});

export const DynamicToolCreateSchema = z.object({
  name: z.string().regex(dynamicToolNameRegex, 'Invalid dynamic tool name'),
  title: z.string().min(1).max(120).optional(),
  description: z.string().min(1).max(4000),
  image: z.string().min(1).max(200).default('node:lts-slim'),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  dependencies: z.array(DynamicDependencySchema).max(64).default([]),
  code: z.string().min(1).max(200_000),
  enabled: z.boolean().default(true)
});

export const DynamicToolUpdateSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().min(1).max(4000).optional(),
  image: z.string().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  dependencies: z.array(DynamicDependencySchema).max(64).optional(),
  code: z.string().min(1).max(200_000).optional(),
  enabled: z.boolean().optional()
});

export const DynamicToolRecordSchema = DynamicToolCreateSchema.extend({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  revision: z.number().int().positive()
});

export const DynamicToolStoreFileSchema = z.object({
  version: z.literal(1),
  tools: z.array(DynamicToolRecordSchema)
});

export type DynamicDependency = z.infer<typeof DynamicDependencySchema>;
export type DynamicToolCreate = z.infer<typeof DynamicToolCreateSchema>;
export type DynamicToolUpdate = z.infer<typeof DynamicToolUpdateSchema>;
export type DynamicToolRecord = z.infer<typeof DynamicToolRecordSchema>;
export type DynamicToolStoreFile = z.infer<typeof DynamicToolStoreFileSchema>;
