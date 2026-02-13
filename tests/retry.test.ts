import { describe, expect, it, vi } from 'vitest';

import { retryAsync } from '../src/lib/retry.js';

describe('retryAsync', () => {
  it('returns the result on first successful attempt', async () => {
    const result = await retryAsync(async () => 'ok', {
      maxAttempts: 3,
      baseDelayMs: 0
    });

    expect(result).toBe('ok');
  });

  it('retries until success within max attempts', async () => {
    let attempt = 0;
    const result = await retryAsync(
      async () => {
        attempt += 1;
        if (attempt < 3) {
          throw new Error(`Attempt ${attempt} failed`);
        }
        return 'success';
      },
      { maxAttempts: 5, baseDelayMs: 0 }
    );

    expect(result).toBe('success');
    expect(attempt).toBe(3);
  });

  it('throws the last error after exhausting max attempts', async () => {
    let attempt = 0;
    await expect(
      retryAsync(
        async () => {
          attempt += 1;
          throw new Error(`Attempt ${attempt}`);
        },
        { maxAttempts: 3, baseDelayMs: 0 }
      )
    ).rejects.toThrow('Attempt 3');

    expect(attempt).toBe(3);
  });

  it('respects shouldRetry predicate - stops on non-retriable errors', async () => {
    let attempt = 0;
    await expect(
      retryAsync(
        async () => {
          attempt += 1;
          throw new Error('syntax error');
        },
        {
          maxAttempts: 5,
          baseDelayMs: 0,
          shouldRetry: (error) =>
            error instanceof Error && !error.message.includes('syntax')
        }
      )
    ).rejects.toThrow('syntax error');

    expect(attempt).toBe(1);
  });

  it('respects shouldRetry predicate - retries on retriable errors', async () => {
    let attempt = 0;
    const result = await retryAsync(
      async () => {
        attempt += 1;
        if (attempt < 3) {
          throw new Error('transient error');
        }
        return 'recovered';
      },
      {
        maxAttempts: 5,
        baseDelayMs: 0,
        shouldRetry: (error) =>
          error instanceof Error && error.message.includes('transient')
      }
    );

    expect(result).toBe('recovered');
    expect(attempt).toBe(3);
  });

  it('applies exponential backoff delay', async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    vi.useFakeTimers();

    let attempt = 0;
    const promise = retryAsync(
      async () => {
        attempt += 1;
        if (attempt <= 3) {
          throw new Error('fail');
        }
        return 'done';
      },
      { maxAttempts: 5, baseDelayMs: 100 }
    );

    // Advance through the delays: 100ms (100*2^0), 200ms (100*2^1), 400ms (100*2^2)
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);

    const result = await promise;
    expect(result).toBe('done');
    expect(attempt).toBe(4);

    vi.useRealTimers();
  });

  it('treats maxAttempts of 1 as no retries', async () => {
    let attempt = 0;
    await expect(
      retryAsync(
        async () => {
          attempt += 1;
          throw new Error('fail');
        },
        { maxAttempts: 1, baseDelayMs: 0 }
      )
    ).rejects.toThrow('fail');

    expect(attempt).toBe(1);
  });

  it('handles maxAttempts of 0 or negative as single attempt', async () => {
    let attempt = 0;
    await expect(
      retryAsync(
        async () => {
          attempt += 1;
          throw new Error('fail');
        },
        { maxAttempts: 0, baseDelayMs: 0 }
      )
    ).rejects.toThrow('fail');

    expect(attempt).toBe(1);
  });

  it('handles baseDelayMs of 0 without errors', async () => {
    let attempt = 0;
    const result = await retryAsync(
      async () => {
        attempt += 1;
        if (attempt < 2) {
          throw new Error('fail');
        }
        return 'ok';
      },
      { maxAttempts: 3, baseDelayMs: 0 }
    );

    expect(result).toBe('ok');
  });

  it('handles negative baseDelayMs gracefully', async () => {
    let attempt = 0;
    const result = await retryAsync(
      async () => {
        attempt += 1;
        if (attempt < 2) {
          throw new Error('fail');
        }
        return 'ok';
      },
      { maxAttempts: 3, baseDelayMs: -100 }
    );

    expect(result).toBe('ok');
  });
});
