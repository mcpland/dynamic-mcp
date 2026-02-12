export interface ToolExecutionGuardOptions {
  maxConcurrency: number;
  maxCallsPerWindow: number;
  windowMs: number;
}

export class ToolExecutionGuard {
  private readonly maxConcurrency: number;
  private readonly maxCallsPerWindow: number;
  private readonly windowMs: number;
  private readonly callHistory = new Map<string, number[]>();
  private activeExecutions = 0;

  constructor(options: ToolExecutionGuardOptions) {
    this.maxConcurrency = options.maxConcurrency;
    this.maxCallsPerWindow = options.maxCallsPerWindow;
    this.windowMs = options.windowMs;
  }

  async run<T>(scope: string, work: () => Promise<T>): Promise<T> {
    this.assertRate(scope);
    this.assertConcurrency();

    this.activeExecutions += 1;

    try {
      return await work();
    } finally {
      this.activeExecutions -= 1;
    }
  }

  private assertConcurrency(): void {
    if (this.activeExecutions >= this.maxConcurrency) {
      throw new Error(
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
      throw new Error(
        `Rate limit exceeded for ${scope}: max ${this.maxCallsPerWindow} calls per ${this.windowMs}ms.`
      );
    }

    recent.push(now);
    this.callHistory.set(scope, recent);
  }
}
