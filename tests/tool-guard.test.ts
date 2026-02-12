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
});
