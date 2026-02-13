import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readJsonFile, writeJsonFileAtomic } from '../src/lib/json-file.js';

describe('readJsonFile', () => {
  it('reads and parses a JSON file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-json-read-'));
    const filePath = join(root, 'data.json');
    await writeFile(filePath, JSON.stringify({ hello: 'world' }), 'utf8');

    const result = await readJsonFile<{ hello: string }>(filePath);
    expect(result).toEqual({ hello: 'world' });
  });

  it('returns null for non-existent files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-json-missing-'));
    const filePath = join(root, 'nonexistent.json');

    const result = await readJsonFile<unknown>(filePath);
    expect(result).toBeNull();
  });

  it('throws on invalid JSON content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-json-bad-'));
    const filePath = join(root, 'bad.json');
    await writeFile(filePath, 'not valid json {{{', 'utf8');

    await expect(readJsonFile<unknown>(filePath)).rejects.toThrow();
  });

  it('reads arrays correctly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-json-array-'));
    const filePath = join(root, 'array.json');
    await writeFile(filePath, JSON.stringify([1, 2, 3]), 'utf8');

    const result = await readJsonFile<number[]>(filePath);
    expect(result).toEqual([1, 2, 3]);
  });

  it('reads nested objects correctly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-json-nested-'));
    const filePath = join(root, 'nested.json');
    const data = { a: { b: { c: 42 } } };
    await writeFile(filePath, JSON.stringify(data), 'utf8');

    const result = await readJsonFile<typeof data>(filePath);
    expect(result).toEqual(data);
  });
});

describe('writeJsonFileAtomic', () => {
  it('writes a JSON file atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-json-write-'));
    const filePath = join(root, 'output.json');

    await writeJsonFileAtomic(filePath, { key: 'value' });

    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({ key: 'value' });
  });

  it('creates parent directories if they do not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-json-mkdirp-'));
    const filePath = join(root, 'deep', 'nested', 'output.json');

    await writeJsonFileAtomic(filePath, { nested: true });

    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({ nested: true });
  });

  it('formats output with 2-space indentation and trailing newline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-json-format-'));
    const filePath = join(root, 'formatted.json');

    await writeJsonFileAtomic(filePath, { a: 1 });

    const content = await readFile(filePath, 'utf8');
    expect(content).toBe('{\n  "a": 1\n}\n');
  });

  it('overwrites existing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-json-overwrite-'));
    const filePath = join(root, 'data.json');

    await writeJsonFileAtomic(filePath, { version: 1 });
    await writeJsonFileAtomic(filePath, { version: 2 });

    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({ version: 2 });
  });

  it('round-trips with readJsonFile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-json-roundtrip-'));
    const filePath = join(root, 'rt.json');
    const data = { tools: [{ name: 'a' }, { name: 'b' }], count: 2 };

    await writeJsonFileAtomic(filePath, data);
    const result = await readJsonFile<typeof data>(filePath);
    expect(result).toEqual(data);
  });
});
