import { describe, expect, it, vi } from 'vitest';

import { SandboxSessionRegistry } from '../src/sandbox/session-registry.js';

function makeSession(id: string, minutesAgo = 0) {
  const date = new Date(Date.now() - minutesAgo * 60_000);
  return {
    id,
    image: 'node:lts-slim',
    createdAt: date.toISOString(),
    lastUsedAt: date.toISOString()
  };
}

describe('SandboxSessionRegistry', () => {
  it('adds and retrieves sessions', () => {
    const registry = new SandboxSessionRegistry();
    const session = makeSession('sess-1');
    registry.add(session, 10);

    const retrieved = registry.get('sess-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe('sess-1');
    expect(retrieved?.image).toBe('node:lts-slim');
  });

  it('returns a clone from get (not a reference)', () => {
    const registry = new SandboxSessionRegistry();
    registry.add(makeSession('sess-1'), 10);

    const a = registry.get('sess-1');
    const b = registry.get('sess-1');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('returns null for non-existent session', () => {
    const registry = new SandboxSessionRegistry();
    expect(registry.get('nonexistent')).toBeNull();
  });

  it('enforces max sessions limit', () => {
    const registry = new SandboxSessionRegistry();
    registry.add(makeSession('sess-1'), 2);
    registry.add(makeSession('sess-2'), 2);

    expect(() => registry.add(makeSession('sess-3'), 2)).toThrow(/limit reached/i);
  });

  it('touches a session to update lastUsedAt', () => {
    const registry = new SandboxSessionRegistry();
    const session = makeSession('sess-1', 10);
    registry.add(session, 10);

    const before = registry.get('sess-1');
    registry.touch('sess-1');
    const after = registry.get('sess-1');

    expect(after!.lastUsedAt).not.toBe(before!.lastUsedAt);
    expect(Date.parse(after!.lastUsedAt)).toBeGreaterThan(Date.parse(before!.lastUsedAt));
  });

  it('touch on non-existent session does not throw', () => {
    const registry = new SandboxSessionRegistry();
    expect(() => registry.touch('nonexistent')).not.toThrow();
  });

  it('removes a session', () => {
    const registry = new SandboxSessionRegistry();
    registry.add(makeSession('sess-1'), 10);

    expect(registry.remove('sess-1')).toBe(true);
    expect(registry.get('sess-1')).toBeNull();
  });

  it('remove returns false for non-existent session', () => {
    const registry = new SandboxSessionRegistry();
    expect(registry.remove('nonexistent')).toBe(false);
  });

  it('lists sessions sorted by createdAt', () => {
    const registry = new SandboxSessionRegistry();
    registry.add(makeSession('sess-b', 5), 10);
    registry.add(makeSession('sess-a', 10), 10);
    registry.add(makeSession('sess-c', 1), 10);

    const listed = registry.list();
    expect(listed.length).toBe(3);
    expect(listed[0].id).toBe('sess-a');
    expect(listed[1].id).toBe('sess-b');
    expect(listed[2].id).toBe('sess-c');
  });

  it('list returns clones (not references)', () => {
    const registry = new SandboxSessionRegistry();
    registry.add(makeSession('sess-1'), 10);

    const list1 = registry.list();
    const list2 = registry.list();
    expect(list1[0]).toEqual(list2[0]);
    expect(list1[0]).not.toBe(list2[0]);
  });

  it('lists empty when no sessions exist', () => {
    const registry = new SandboxSessionRegistry();
    expect(registry.list()).toEqual([]);
  });

  it('cleanupIdleSessions removes stale sessions', async () => {
    vi.mock('../src/sandbox/docker.js', () => ({
      runDocker: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      ensureDockerAvailable: vi.fn().mockResolvedValue(undefined)
    }));

    const registry = new SandboxSessionRegistry();
    registry.add(makeSession('sess-stale', 30), 10);
    registry.add(makeSession('sess-fresh', 0), 10);

    const cleaned = await registry.cleanupIdleSessions({
      dockerBinary: 'docker',
      timeoutMs: 10 * 60_000
    });

    expect(cleaned).toBe(1);
    expect(registry.get('sess-stale')).toBeNull();
    expect(registry.get('sess-fresh')).not.toBeNull();

    vi.restoreAllMocks();
  });

  it('cleanupAll removes all sessions', async () => {
    vi.mock('../src/sandbox/docker.js', () => ({
      runDocker: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      ensureDockerAvailable: vi.fn().mockResolvedValue(undefined)
    }));

    const registry = new SandboxSessionRegistry();
    registry.add(makeSession('sess-1'), 10);
    registry.add(makeSession('sess-2'), 10);

    await registry.cleanupAll('docker');

    expect(registry.list()).toEqual([]);

    vi.restoreAllMocks();
  });
});
