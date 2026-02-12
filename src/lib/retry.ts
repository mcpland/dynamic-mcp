export interface RetryAsyncOptions {
  maxAttempts: number;
  baseDelayMs: number;
  shouldRetry?: (error: unknown) => boolean;
}

export async function retryAsync<T>(
  operation: () => Promise<T>,
  options: RetryAsyncOptions
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts);
  const baseDelayMs = Math.max(0, options.baseDelayMs);

  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      const allowed = options.shouldRetry ? options.shouldRetry(error) : true;
      if (!allowed || attempt >= maxAttempts) {
        throw error;
      }

      const backoff = baseDelayMs * 2 ** (attempt - 1);
      await delay(backoff);
    }
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
