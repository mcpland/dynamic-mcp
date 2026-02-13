import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { DynamicToolRegistry } from '../src/dynamic/registry.js';

describe('DynamicToolRegistry', () => {
  it('creates, updates, reloads, and removes dynamic tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-'));
    const filePath = join(root, 'tools.json');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 5 });
    await registry.load();

    const created = await registry.create({
      name: 'dynamic.echo',
      description: 'Echo with sandbox',
      image: 'node:lts-slim',
      timeoutMs: 10_000,
      dependencies: [{ name: 'zod', version: '^4.3.6' }],
      code: 'console.log(args.message);',
      enabled: true
    });

    expect(created.name).toBe('dynamic.echo');
    expect(created.revision).toBe(1);

    const updated = await registry.update('dynamic.echo', {
      description: 'Echo with sandbox updated',
      enabled: false
    });

    expect(updated.description).toBe('Echo with sandbox updated');
    expect(updated.enabled).toBe(false);
    expect(updated.revision).toBe(2);

    await expect(
      registry.update(
        'dynamic.echo',
        {
          description: 'stale update attempt'
        },
        1
      )
    ).rejects.toThrow(/revision conflict/i);

    const registryReloaded = new DynamicToolRegistry({ filePath, maxTools: 5 });
    await registryReloaded.load();

    const loaded = await registryReloaded.get('dynamic.echo');
    expect(loaded?.description).toBe('Echo with sandbox updated');
    expect(loaded?.revision).toBe(2);

    const removed = await registryReloaded.remove('dynamic.echo');
    expect(removed).toBe(true);
    expect(await registryReloaded.get('dynamic.echo')).toBeNull();

    const content = await readFile(filePath, 'utf8');
    expect(content).toContain('"tools": []');
  });

  it('enforces the dynamic tool max limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-limit-'));
    const filePath = join(root, 'tools.json');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 1 });
    await registry.load();

    await registry.create({
      name: 'dynamic.a',
      description: 'A',
      code: 'console.log(1);'
    });

    await expect(
      registry.create({
        name: 'dynamic.b',
        description: 'B',
        code: 'console.log(2);'
      })
    ).rejects.toThrow(/limit reached/i);
  });

  it('rejects duplicate tool creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-dup-'));
    const filePath = join(root, 'tools.json');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 5 });
    await registry.load();

    await registry.create({
      name: 'dynamic.dup',
      description: 'First',
      code: 'return 1;'
    });

    await expect(
      registry.create({
        name: 'dynamic.dup',
        description: 'Second',
        code: 'return 2;'
      })
    ).rejects.toThrow(/already exists/i);
  });

  it('returns null for non-existent tool via get', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-get-null-'));
    const filePath = join(root, 'tools.json');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 5 });
    await registry.load();

    const result = await registry.get('nonexistent.tool');
    expect(result).toBeNull();
  });

  it('returns false when removing non-existent tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-rm-null-'));
    const filePath = join(root, 'tools.json');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 5 });
    await registry.load();

    const removed = await registry.remove('nonexistent.tool');
    expect(removed).toBe(false);
  });

  it('throws on update of non-existent tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-update-null-'));
    const filePath = join(root, 'tools.json');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 5 });
    await registry.load();

    await expect(
      registry.update('nonexistent.tool', { description: 'new' })
    ).rejects.toThrow(/not found/i);
  });

  it('lists tools sorted by name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-list-'));
    const filePath = join(root, 'tools.json');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 10 });
    await registry.load();

    await registry.create({ name: 'dynamic.zzz', description: 'Z', code: 'z' });
    await registry.create({ name: 'dynamic.aaa', description: 'A', code: 'a' });
    await registry.create({ name: 'dynamic.mmm', description: 'M', code: 'm' });

    const list = await registry.list();
    expect(list.map((t) => t.name)).toEqual([
      'dynamic.aaa',
      'dynamic.mmm',
      'dynamic.zzz'
    ]);
  });

  it('returns an empty list when no tools exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-empty-'));
    const filePath = join(root, 'tools.json');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 5 });
    await registry.load();

    const list = await registry.list();
    expect(list).toEqual([]);
  });

  it('returns clones from get and list (not references)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-clone-'));
    const filePath = join(root, 'tools.json');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 5 });
    await registry.load();

    await registry.create({ name: 'dynamic.ref', description: 'Ref test', code: 'x' });

    const a = await registry.get('dynamic.ref');
    const b = await registry.get('dynamic.ref');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('setEnabled updates enabled flag via update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-enable-'));
    const filePath = join(root, 'tools.json');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 5 });
    await registry.load();

    await registry.create({
      name: 'dynamic.toggle',
      description: 'Toggle test',
      code: 'x',
      enabled: true
    });

    const disabled = await registry.setEnabled('dynamic.toggle', false);
    expect(disabled.enabled).toBe(false);
    expect(disabled.revision).toBe(2);

    const enabled = await registry.setEnabled('dynamic.toggle', true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.revision).toBe(3);
  });

  it('setEnabled with expectedRevision enforces revision check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-enable-rev-'));
    const filePath = join(root, 'tools.json');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 5 });
    await registry.load();

    await registry.create({
      name: 'dynamic.revcheck',
      description: 'Rev check',
      code: 'x',
      enabled: true
    });

    await expect(
      registry.setEnabled('dynamic.revcheck', false, 99)
    ).rejects.toThrow(/revision conflict/i);
  });

  it('throws when operating before load()', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-noload-'));
    const filePath = join(root, 'tools.json');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 5 });

    await expect(registry.list()).rejects.toThrow(/not loaded/i);
    await expect(registry.get('any')).rejects.toThrow(/not loaded/i);
    await expect(
      registry.create({ name: 'any.thing', description: 'x', code: 'x' })
    ).rejects.toThrow(/not loaded/i);
  });

  it('load is idempotent - second call is a no-op', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-reload-'));
    const filePath = join(root, 'tools.json');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 5 });
    await registry.load();
    await registry.create({ name: 'dynamic.idempotent', description: 'x', code: 'x' });

    // Second load should not clear the registry
    await registry.load();
    const tool = await registry.get('dynamic.idempotent');
    expect(tool).not.toBeNull();
  });

  it('throws on invalid store file format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-badfile-'));
    const filePath = join(root, 'tools.json');
    await writeFile(filePath, JSON.stringify({ version: 999, tools: [] }), 'utf8');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 5 });
    await expect(registry.load()).rejects.toThrow(/invalid dynamic tool store/i);
  });

  it('remove with expectedRevision enforces revision check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-registry-rm-rev-'));
    const filePath = join(root, 'tools.json');

    const registry = new DynamicToolRegistry({ filePath, maxTools: 5 });
    await registry.load();

    await registry.create({
      name: 'dynamic.rmrev',
      description: 'Remove with revision',
      code: 'x'
    });

    await expect(registry.remove('dynamic.rmrev', 99)).rejects.toThrow(
      /revision conflict/i
    );

    // Correct revision should work
    const removed = await registry.remove('dynamic.rmrev', 1);
    expect(removed).toBe(true);
  });
});
