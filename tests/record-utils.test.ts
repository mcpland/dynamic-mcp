import { describe, expect, it } from 'vitest';

import { buildCreatedRecord, buildUpdatedRecord } from '../src/dynamic/record-utils.js';
import type { DynamicToolCreate, DynamicToolRecord } from '../src/dynamic/spec.js';

describe('buildCreatedRecord', () => {
  it('builds a record with revision 1 and timestamps', () => {
    const input: DynamicToolCreate = {
      name: 'my.tool',
      description: 'A test tool',
      code: 'return 1;',
      image: 'node:lts-slim',
      timeoutMs: 30_000,
      dependencies: [],
      enabled: true
    };

    const record = buildCreatedRecord(input);

    expect(record.name).toBe('my.tool');
    expect(record.description).toBe('A test tool');
    expect(record.code).toBe('return 1;');
    expect(record.image).toBe('node:lts-slim');
    expect(record.timeoutMs).toBe(30_000);
    expect(record.dependencies).toEqual([]);
    expect(record.enabled).toBe(true);
    expect(record.revision).toBe(1);
    expect(record.createdAt).toBeDefined();
    expect(record.updatedAt).toBeDefined();
    expect(record.createdAt).toBe(record.updatedAt);
  });

  it('applies default values from the schema', () => {
    const input = {
      name: 'my.tool',
      description: 'Test',
      code: 'return 1;'
    } as DynamicToolCreate;

    const record = buildCreatedRecord(input);

    expect(record.image).toBe('node:lts-slim');
    expect(record.timeoutMs).toBe(30_000);
    expect(record.dependencies).toEqual([]);
    expect(record.enabled).toBe(true);
  });

  it('includes dependencies when provided', () => {
    const input: DynamicToolCreate = {
      name: 'dep.tool',
      description: 'Tool with deps',
      code: 'return 1;',
      image: 'node:lts-slim',
      timeoutMs: 10_000,
      dependencies: [
        { name: 'zod', version: '^3.0.0' },
        { name: 'lodash', version: '^4.17.0' }
      ],
      enabled: true
    };

    const record = buildCreatedRecord(input);
    expect(record.dependencies).toHaveLength(2);
    expect(record.dependencies[0].name).toBe('zod');
    expect(record.dependencies[1].name).toBe('lodash');
  });

  it('produces ISO datetime strings', () => {
    const record = buildCreatedRecord({
      name: 'ts.tool',
      description: 'Timestamp check',
      code: 'return 1;'
    } as DynamicToolCreate);

    expect(() => new Date(record.createdAt)).not.toThrow();
    expect(new Date(record.createdAt).toISOString()).toBe(record.createdAt);
  });
});

describe('buildUpdatedRecord', () => {
  const baseRecord: DynamicToolRecord = {
    name: 'my.tool',
    description: 'Original',
    code: 'return 1;',
    image: 'node:lts-slim',
    timeoutMs: 30_000,
    dependencies: [],
    enabled: true,
    revision: 1,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  };

  it('increments revision by 1', () => {
    const updated = buildUpdatedRecord(baseRecord, { description: 'Updated' });
    expect(updated.revision).toBe(2);
  });

  it('preserves createdAt from the original', () => {
    const updated = buildUpdatedRecord(baseRecord, { description: 'Updated' });
    expect(updated.createdAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('updates updatedAt to a new timestamp', () => {
    const updated = buildUpdatedRecord(baseRecord, { description: 'Updated' });
    expect(updated.updatedAt).not.toBe('2025-01-01T00:00:00.000Z');
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
      new Date('2025-01-01T00:00:00.000Z').getTime()
    );
  });

  it('applies only provided patch fields', () => {
    const updated = buildUpdatedRecord(baseRecord, { description: 'New description' });

    expect(updated.description).toBe('New description');
    expect(updated.code).toBe('return 1;');
    expect(updated.image).toBe('node:lts-slim');
    expect(updated.enabled).toBe(true);
  });

  it('can update multiple fields at once', () => {
    const updated = buildUpdatedRecord(baseRecord, {
      description: 'New description',
      code: 'return 2;',
      timeoutMs: 60_000,
      enabled: false
    });

    expect(updated.description).toBe('New description');
    expect(updated.code).toBe('return 2;');
    expect(updated.timeoutMs).toBe(60_000);
    expect(updated.enabled).toBe(false);
  });

  it('can update dependencies', () => {
    const updated = buildUpdatedRecord(baseRecord, {
      dependencies: [{ name: 'axios', version: '^1.0.0' }]
    });

    expect(updated.dependencies).toHaveLength(1);
    expect(updated.dependencies[0].name).toBe('axios');
  });

  it('preserves the tool name', () => {
    const updated = buildUpdatedRecord(baseRecord, { description: 'Changed' });
    expect(updated.name).toBe('my.tool');
  });

  it('can update title', () => {
    const updated = buildUpdatedRecord(baseRecord, { title: 'My New Title' });
    expect(updated.title).toBe('My New Title');
  });

  it('can update image', () => {
    const updated = buildUpdatedRecord(baseRecord, { image: 'node:22-alpine' });
    expect(updated.image).toBe('node:22-alpine');
  });
});
