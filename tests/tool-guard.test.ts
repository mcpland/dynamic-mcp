import { describe, expect, it } from 'vitest';

import { ToolExecutionGuard } from '../src/security/guard.js';

describe('ToolExecutionGuard', () => {
  it('allows normal execution and records metrics', async () => {
    const guard = new ToolExecutionGuard({
      maxConcurrency: 2,
      maxCallsPerWindow: 10,
      windowMs: 1_000
    });

    const result = await guard.run('scope.a', async () => 'ok');
    expect(result).toBe('ok');

    const snapshot = guard.snapshot();
    expect(snapshot.activeExecutions).toBe(0);
    expect(snapshot.scopes[0]?.scope).toBe('scope.a');
    expect(snapshot.scopes[0]?.allowed).toBe(1);
  });

  it('rejects by concurrency', async () => {
    const guard = new ToolExecutionGuard({
      maxConcurrency: 1,
      maxCallsPerWindow: 10,
      windowMs: 1_000
    });

    const first = guard.run('scope.concurrent', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 'first';
    });

    await expect(
      guard.run('scope.concurrent', async () => {
        return 'second';
      })
    ).rejects.toThrow(/Too many concurrent/);

    await first;
  });

  it('rejects by rate limit', async () => {
    const guard = new ToolExecutionGuard({
      maxConcurrency: 2,
      maxCallsPerWindow: 1,
      windowMs: 10_000
    });

    await guard.run('scope.rate', async () => 'first');

    await expect(
      guard.run('scope.rate', async () => {
        return 'second';
      })
    ).rejects.toThrow(/Rate limit exceeded/);
  });

  it('tracks failed execution stats', async () => {
    const guard = new ToolExecutionGuard({
      maxConcurrency: 4,
      maxCallsPerWindow: 100,
      windowMs: 60_000
    });

    await expect(
      guard.run('scope.fail', async () => {
        throw new Error('intentional error');
      })
    ).rejects.toThrow('intentional error');

    const snapshot = guard.snapshot();
    const scopeStats = snapshot.scopes.find((s) => s.scope === 'scope.fail');
    expect(scopeStats).toBeDefined();
    expect(scopeStats?.total).toBe(1);
    expect(scopeStats?.allowed).toBe(1);
    expect(scopeStats?.failed).toBe(1);
  });

  it('tracks concurrency rejection stats', async () => {
    const guard = new ToolExecutionGuard({
      maxConcurrency: 1,
      maxCallsPerWindow: 100,
      windowMs: 60_000
    });

    const blocker = guard.run('scope.conc', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 'done';
    });

    await expect(guard.run('scope.conc', async () => 'overflow')).rejects.toThrow(
      /Too many concurrent/
    );

    await blocker;

    const snapshot = guard.snapshot();
    const scopeStats = snapshot.scopes.find((s) => s.scope === 'scope.conc');
    expect(scopeStats).toBeDefined();
    expect(scopeStats?.total).toBe(2);
    expect(scopeStats?.allowed).toBe(1);
    expect(scopeStats?.rejectedConcurrency).toBe(1);
    expect(scopeStats?.rejectedRate).toBe(0);
  });

  it('tracks rate rejection stats', async () => {
    const guard = new ToolExecutionGuard({
      maxConcurrency: 10,
      maxCallsPerWindow: 1,
      windowMs: 60_000
    });

    await guard.run('scope.rl', async () => 'ok');
    await expect(guard.run('scope.rl', async () => 'overflow')).rejects.toThrow(
      /Rate limit exceeded/
    );

    const snapshot = guard.snapshot();
    const scopeStats = snapshot.scopes.find((s) => s.scope === 'scope.rl');
    expect(scopeStats?.rejectedRate).toBe(1);
    expect(scopeStats?.rejectedConcurrency).toBe(0);
  });

  it('tracks multiple scopes independently', async () => {
    const guard = new ToolExecutionGuard({
      maxConcurrency: 4,
      maxCallsPerWindow: 100,
      windowMs: 60_000
    });

    await guard.run('scope.alpha', async () => 'a');
    await guard.run('scope.alpha', async () => 'a');
    await guard.run('scope.beta', async () => 'b');

    const snapshot = guard.snapshot();
    expect(snapshot.scopes.length).toBe(2);

    const alpha = snapshot.scopes.find((s) => s.scope === 'scope.alpha');
    const beta = snapshot.scopes.find((s) => s.scope === 'scope.beta');
    expect(alpha?.total).toBe(2);
    expect(alpha?.allowed).toBe(2);
    expect(beta?.total).toBe(1);
    expect(beta?.allowed).toBe(1);
  });

  it('snapshot scopes are sorted alphabetically', async () => {
    const guard = new ToolExecutionGuard({
      maxConcurrency: 4,
      maxCallsPerWindow: 100,
      windowMs: 60_000
    });

    await guard.run('scope.zebra', async () => 'z');
    await guard.run('scope.alpha', async () => 'a');
    await guard.run('scope.middle', async () => 'm');

    const snapshot = guard.snapshot();
    expect(snapshot.scopes.map((s) => s.scope)).toEqual([
      'scope.alpha',
      'scope.middle',
      'scope.zebra'
    ]);
  });

  it('snapshot shows limits configuration', () => {
    const guard = new ToolExecutionGuard({
      maxConcurrency: 5,
      maxCallsPerWindow: 50,
      windowMs: 30_000
    });

    const snapshot = guard.snapshot();
    expect(snapshot.limits).toEqual({
      maxConcurrency: 5,
      maxCallsPerWindow: 50,
      windowMs: 30_000
    });
  });

  it('decrements activeExecutions even when work throws', async () => {
    const guard = new ToolExecutionGuard({
      maxConcurrency: 2,
      maxCallsPerWindow: 100,
      windowMs: 60_000
    });

    await expect(
      guard.run('scope.err', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(guard.snapshot().activeExecutions).toBe(0);
  });

  it('rate limit is scoped - different scopes have independent limits', async () => {
    const guard = new ToolExecutionGuard({
      maxConcurrency: 10,
      maxCallsPerWindow: 1,
      windowMs: 60_000
    });

    await guard.run('scope.a', async () => 'ok');

    // scope.b should not be affected by scope.a's rate
    const result = await guard.run('scope.b', async () => 'also ok');
    expect(result).toBe('also ok');
  });
});
