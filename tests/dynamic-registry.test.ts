import { mkdtemp, readFile } from 'node:fs/promises';
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
});
