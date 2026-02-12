import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditLoggerOptions {
  enabled: boolean;
  filePath: string;
  maxEventBytes: number;
  service: string;
  serviceVersion: string;
}

export interface AuditEvent {
  action: string;
  actor?: string;
  target?: string;
  result: 'success' | 'error' | 'denied';
  details?: Record<string, unknown>;
}

export class AuditLogger {
  private readonly enabled: boolean;
  private readonly filePath: string;
  private readonly maxEventBytes: number;
  private readonly service: string;
  private readonly serviceVersion: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: AuditLoggerOptions) {
    this.enabled = options.enabled;
    this.filePath = options.filePath;
    this.maxEventBytes = options.maxEventBytes;
    this.service = options.service;
    this.serviceVersion = options.serviceVersion;
  }

  log(event: AuditEvent): Promise<void> {
    if (!this.enabled) {
      return Promise.resolve();
    }

    this.writeChain = this.writeChain.then(async () => {
      const payload = {
        timestamp: new Date().toISOString(),
        service: this.service,
        serviceVersion: this.serviceVersion,
        ...event
      };

      let line = JSON.stringify(payload);
      if (Buffer.byteLength(line, 'utf8') > this.maxEventBytes) {
        const reduced = {
          ...payload,
          details: {
            truncated: true,
            reason: `payload exceeds ${this.maxEventBytes} bytes`
          }
        };
        line = JSON.stringify(reduced);
      }

      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${line}\n`, 'utf8');
    });

    return this.writeChain.catch(() => {
      // Keep audit failures from breaking tool execution.
    });
  }
}
