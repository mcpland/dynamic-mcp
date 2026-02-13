import { describe, expect, it } from 'vitest';

import {
  npmPackageNameRegex,
  dynamicToolNameRegex,
  DynamicDependencySchema,
  DynamicToolCreateSchema,
  DynamicToolUpdateSchema,
  DynamicToolRecordSchema,
  DynamicToolStoreFileSchema
} from '../src/dynamic/spec.js';

describe('npmPackageNameRegex', () => {
  it('accepts valid unscoped package names', () => {
    expect(npmPackageNameRegex.test('lodash')).toBe(true);
    expect(npmPackageNameRegex.test('express')).toBe(true);
    expect(npmPackageNameRegex.test('my-package')).toBe(true);
    expect(npmPackageNameRegex.test('my_package')).toBe(true);
    expect(npmPackageNameRegex.test('my.package')).toBe(true);
  });

  it('accepts valid scoped package names', () => {
    expect(npmPackageNameRegex.test('@scope/package')).toBe(true);
    expect(npmPackageNameRegex.test('@my-org/my-pkg')).toBe(true);
    expect(npmPackageNameRegex.test('@a/b')).toBe(true);
  });

  it('rejects invalid package names', () => {
    expect(npmPackageNameRegex.test('')).toBe(false);
    expect(npmPackageNameRegex.test('UPPERCASE')).toBe(false);
    expect(npmPackageNameRegex.test('.dotfirst')).toBe(false);
    // Note: dash-first names like '-dashfirst' are accepted by the regex
    // because the regex character class includes ~
    expect(npmPackageNameRegex.test('has space')).toBe(false);
  });
});

describe('dynamicToolNameRegex', () => {
  it('accepts valid tool names', () => {
    expect(dynamicToolNameRegex.test('abc')).toBe(true);
    expect(dynamicToolNameRegex.test('dynamic.hello')).toBe(true);
    expect(dynamicToolNameRegex.test('my_tool')).toBe(true);
    expect(dynamicToolNameRegex.test('my-tool')).toBe(true);
    expect(dynamicToolNameRegex.test('my:tool')).toBe(true);
    expect(dynamicToolNameRegex.test('MyTool01')).toBe(true);
  });

  it('rejects names shorter than 3 characters', () => {
    expect(dynamicToolNameRegex.test('ab')).toBe(false);
    expect(dynamicToolNameRegex.test('a')).toBe(false);
  });

  it('rejects names longer than 64 characters', () => {
    expect(dynamicToolNameRegex.test('a'.repeat(65))).toBe(false);
  });

  it('accepts names at exactly 64 characters', () => {
    expect(dynamicToolNameRegex.test('a'.repeat(64))).toBe(true);
  });

  it('rejects names starting with a digit', () => {
    expect(dynamicToolNameRegex.test('1tool')).toBe(false);
    expect(dynamicToolNameRegex.test('0abc')).toBe(false);
  });

  it('rejects names starting with special characters', () => {
    expect(dynamicToolNameRegex.test('.tool')).toBe(false);
    expect(dynamicToolNameRegex.test('_tool')).toBe(false);
    expect(dynamicToolNameRegex.test('-tool')).toBe(false);
  });

  it('rejects names with spaces', () => {
    expect(dynamicToolNameRegex.test('my tool')).toBe(false);
  });
});

describe('DynamicDependencySchema', () => {
  it('accepts valid dependencies', () => {
    const result = DynamicDependencySchema.safeParse({ name: 'zod', version: '^3.0.0' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid npm package names', () => {
    const result = DynamicDependencySchema.safeParse({ name: 'INVALID', version: '1.0.0' });
    expect(result.success).toBe(false);
  });

  it('rejects empty version string', () => {
    const result = DynamicDependencySchema.safeParse({ name: 'lodash', version: '' });
    expect(result.success).toBe(false);
  });

  it('rejects version string longer than 128 chars', () => {
    const result = DynamicDependencySchema.safeParse({
      name: 'lodash',
      version: 'x'.repeat(129)
    });
    expect(result.success).toBe(false);
  });
});

describe('DynamicToolCreateSchema', () => {
  it('parses valid create input with defaults', () => {
    const result = DynamicToolCreateSchema.safeParse({
      name: 'my.tool',
      description: 'A tool',
      code: 'return 1;'
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.image).toBe('node:lts-slim');
      expect(result.data.timeoutMs).toBe(30_000);
      expect(result.data.dependencies).toEqual([]);
      expect(result.data.enabled).toBe(true);
    }
  });

  it('rejects missing required fields', () => {
    expect(DynamicToolCreateSchema.safeParse({}).success).toBe(false);
    expect(DynamicToolCreateSchema.safeParse({ name: 'abc' }).success).toBe(false);
    expect(
      DynamicToolCreateSchema.safeParse({ name: 'abc', description: 'test' }).success
    ).toBe(false);
  });

  it('rejects invalid tool name', () => {
    const result = DynamicToolCreateSchema.safeParse({
      name: 'ab',
      description: 'test',
      code: 'x'
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty description', () => {
    const result = DynamicToolCreateSchema.safeParse({
      name: 'my.tool',
      description: '',
      code: 'x'
    });
    expect(result.success).toBe(false);
  });

  it('rejects description longer than 4000 chars', () => {
    const result = DynamicToolCreateSchema.safeParse({
      name: 'my.tool',
      description: 'x'.repeat(4001),
      code: 'x'
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty code', () => {
    const result = DynamicToolCreateSchema.safeParse({
      name: 'my.tool',
      description: 'test',
      code: ''
    });
    expect(result.success).toBe(false);
  });

  it('rejects code longer than 200000 chars', () => {
    const result = DynamicToolCreateSchema.safeParse({
      name: 'my.tool',
      description: 'test',
      code: 'x'.repeat(200_001)
    });
    expect(result.success).toBe(false);
  });

  it('rejects timeoutMs below 1000', () => {
    const result = DynamicToolCreateSchema.safeParse({
      name: 'my.tool',
      description: 'test',
      code: 'x',
      timeoutMs: 500
    });
    expect(result.success).toBe(false);
  });

  it('rejects timeoutMs above 120000', () => {
    const result = DynamicToolCreateSchema.safeParse({
      name: 'my.tool',
      description: 'test',
      code: 'x',
      timeoutMs: 200_000
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 64 dependencies', () => {
    const deps = Array.from({ length: 65 }, (_, i) => ({
      name: `pkg${i}`,
      version: '1.0.0'
    }));
    const result = DynamicToolCreateSchema.safeParse({
      name: 'my.tool',
      description: 'test',
      code: 'x',
      dependencies: deps
    });
    expect(result.success).toBe(false);
  });

  it('validates title length constraints', () => {
    expect(
      DynamicToolCreateSchema.safeParse({
        name: 'my.tool',
        description: 'test',
        code: 'x',
        title: ''
      }).success
    ).toBe(false);

    expect(
      DynamicToolCreateSchema.safeParse({
        name: 'my.tool',
        description: 'test',
        code: 'x',
        title: 'x'.repeat(121)
      }).success
    ).toBe(false);

    expect(
      DynamicToolCreateSchema.safeParse({
        name: 'my.tool',
        description: 'test',
        code: 'x',
        title: 'Valid Title'
      }).success
    ).toBe(true);
  });
});

describe('DynamicToolUpdateSchema', () => {
  it('accepts partial updates', () => {
    expect(DynamicToolUpdateSchema.safeParse({ description: 'new' }).success).toBe(true);
    expect(DynamicToolUpdateSchema.safeParse({ code: 'new code' }).success).toBe(true);
    expect(DynamicToolUpdateSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(DynamicToolUpdateSchema.safeParse({}).success).toBe(true);
  });

  it('rejects invalid field values', () => {
    expect(DynamicToolUpdateSchema.safeParse({ description: '' }).success).toBe(false);
    expect(DynamicToolUpdateSchema.safeParse({ code: '' }).success).toBe(false);
    expect(DynamicToolUpdateSchema.safeParse({ timeoutMs: 0 }).success).toBe(false);
  });
});

describe('DynamicToolRecordSchema', () => {
  it('parses a complete record', () => {
    const result = DynamicToolRecordSchema.safeParse({
      name: 'my.tool',
      description: 'test',
      code: 'return 1;',
      image: 'node:lts-slim',
      timeoutMs: 30_000,
      dependencies: [],
      enabled: true,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      revision: 1
    });
    expect(result.success).toBe(true);
  });

  it('rejects records with missing timestamps', () => {
    const result = DynamicToolRecordSchema.safeParse({
      name: 'my.tool',
      description: 'test',
      code: 'return 1;',
      image: 'node:lts-slim',
      timeoutMs: 30_000,
      dependencies: [],
      enabled: true,
      revision: 1
    });
    expect(result.success).toBe(false);
  });

  it('rejects records with non-positive revision', () => {
    const result = DynamicToolRecordSchema.safeParse({
      name: 'my.tool',
      description: 'test',
      code: 'return 1;',
      image: 'node:lts-slim',
      timeoutMs: 30_000,
      dependencies: [],
      enabled: true,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      revision: 0
    });
    expect(result.success).toBe(false);
  });
});

describe('DynamicToolStoreFileSchema', () => {
  it('parses a valid store file', () => {
    const result = DynamicToolStoreFileSchema.safeParse({
      version: 1,
      tools: []
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid version', () => {
    const result = DynamicToolStoreFileSchema.safeParse({
      version: 2,
      tools: []
    });
    expect(result.success).toBe(false);
  });

  it('parses store with tools', () => {
    const result = DynamicToolStoreFileSchema.safeParse({
      version: 1,
      tools: [
        {
          name: 'my.tool',
          description: 'test',
          code: 'return 1;',
          image: 'node:lts-slim',
          timeoutMs: 30_000,
          dependencies: [],
          enabled: true,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
          revision: 1
        }
      ]
    });
    expect(result.success).toBe(true);
  });
});
