export interface ToolExecutionGuardOptions {
  maxConcurrency: number;
  maxCallsPerWindow: number;
  windowMs: number;
}

interface ScopeStats {
  total: number;
  allowed: number;
  rejectedRate: number;
  rejectedConcurrency: number;
  failed: number;
}

export class ToolExecutionGuard {
  private readonly maxConcurrency: number;
  private readonly maxCallsPerWindow: number;
  private readonly windowMs: number;
  private readonly callHistory = new Map<string, number[]>();
  private readonly scopeStats = new Map<string, ScopeStats>();
  private activeExecutions = 0;

  constructor(options: ToolExecutionGuardOptions) {
    this.maxConcurrency = options.maxConcurrency;
    this.maxCallsPerWindow = options.maxCallsPerWindow;
    this.windowMs = options.windowMs;
  }

  async run<T>(scope: string, work: () => Promise<T>): Promise<T> {
    const stats = this.getOrCreateScopeStats(scope);
    stats.total += 1;

    try {
      this.assertRate(scope);
      this.assertConcurrency();
    } catch (error) {
      if (error instanceof GuardRejectionError) {
        if (error.kind === 'rate') {
          stats.rejectedRate += 1;
        } else {
          stats.rejectedConcurrency += 1;
        }
      }
      throw error;
    }

    this.activeExecutions += 1;
    stats.allowed += 1;

    try {
      return await work();
    } catch (error) {
      stats.failed += 1;
      throw error;
    } finally {
      this.activeExecutions -= 1;
    }
  }

  snapshot() {
    return {
      activeExecutions: this.activeExecutions,
      limits: {
        maxConcurrency: this.maxConcurrency,
        maxCallsPerWindow: this.maxCallsPerWindow,
        windowMs: this.windowMs
      },
      scopes: [...this.scopeStats.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([scope, stats]) => ({ scope, ...stats }))
    };
  }

  private assertConcurrency(): void {
    if (this.activeExecutions >= this.maxConcurrency) {
      throw new GuardRejectionError(
        'concurrency',
        `Too many concurrent tool executions (${this.activeExecutions}/${this.maxConcurrency}).`
      );
    }
  }

  private assertRate(scope: string): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    const current = this.callHistory.get(scope) ?? [];
    const recent = current.filter((timestamp) => timestamp >= windowStart);

    if (recent.length >= this.maxCallsPerWindow) {
      throw new GuardRejectionError(
        'rate',
        `Rate limit exceeded for ${scope}: max ${this.maxCallsPerWindow} calls per ${this.windowMs}ms.`
      );
    }

    recent.push(now);
    this.callHistory.set(scope, recent);
  }

  private getOrCreateScopeStats(scope: string): ScopeStats {
    const existing = this.scopeStats.get(scope);
    if (existing) {
      return existing;
    }

    const created: ScopeStats = {
      total: 0,
      allowed: 0,
      rejectedRate: 0,
      rejectedConcurrency: 0,
      failed: 0
    };
    this.scopeStats.set(scope, created);
    return created;
  }
}

class GuardRejectionError extends Error {
  readonly kind: 'rate' | 'concurrency';

  constructor(kind: 'rate' | 'concurrency', message: string) {
    super(message);
    this.kind = kind;
  }
}
