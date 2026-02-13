import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditLoggerOptions {
  enabled: boolean;
  filePath: string;
  maxEventBytes: number;
  maxFileBytes: number;
  maxFiles: number;
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
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly service: string;
  private readonly serviceVersion: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: AuditLoggerOptions) {
    this.enabled = options.enabled;
    this.filePath = options.filePath;
    this.maxEventBytes = options.maxEventBytes;
    this.maxFileBytes = options.maxFileBytes;
    this.maxFiles = options.maxFiles;
    this.service = options.service;
    this.serviceVersion = options.serviceVersion;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  log(event: AuditEvent): Promise<void> {
    if (!this.enabled) {
      return Promise.resolve();
    }

    this.writeChain = this.writeChain
      .catch(() => {
        // Keep the chain alive after failed writes.
      })
      .then(async () => {
        const sanitizedEvent = sanitizeAuditEvent(event);
        const payload = {
          timestamp: new Date().toISOString(),
          service: this.service,
          serviceVersion: this.serviceVersion,
          ...sanitizedEvent
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
        await this.rotateIfNeeded(line);
        await appendFile(this.filePath, `${line}\n`, 'utf8');
      });

    return this.flush();
  }

  flush(): Promise<void> {
    return this.writeChain.catch(() => {
      // Keep audit failures from breaking caller flows.
    });
  }

  private async rotateIfNeeded(line: string): Promise<void> {
    const incomingBytes = Buffer.byteLength(`${line}\n`, 'utf8');
    const currentSize = await this.currentFileSize();
    if (currentSize + incomingBytes <= this.maxFileBytes) {
      return;
    }

    await removeIfExists(`${this.filePath}.${this.maxFiles}`);
    for (let idx = this.maxFiles - 1; idx >= 1; idx -= 1) {
      await renameIfExists(`${this.filePath}.${idx}`, `${this.filePath}.${idx + 1}`);
    }
    await renameIfExists(this.filePath, `${this.filePath}.1`);
  }

  private async currentFileSize(): Promise<number> {
    try {
      const fileStat = await stat(this.filePath);
      return fileStat.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }

      throw error;
    }
  }
}

async function renameIfExists(fromPath: string, toPath: string): Promise<void> {
  try {
    await rename(fromPath, toPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

function sanitizeAuditEvent(event: AuditEvent): AuditEvent {
  if (!event.details) {
    return event;
  }

  return {
    ...event,
    details: sanitizeDetailsObject(event.details, 0)
  };
}

function sanitizeDetailsObject(
  input: Record<string, unknown>,
  depth: number
): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (sensitiveDetailKeyPattern.test(key)) {
      output[key] = '[REDACTED]';
      continue;
    }

    output[key] = sanitizeDetailsValue(value, depth + 1);
  }

  return output;
}

function sanitizeDetailsValue(value: unknown, depth: number): unknown {
  if (depth > 8) {
    return '[TRUNCATED_DEPTH]';
  }

  if (value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDetailsValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    return sanitizeDetailsObject(value as Record<string, unknown>, depth + 1);
  }

  return value;
}

const sensitiveDetailKeyPattern =
  /(?:token|password|secret|authorization|cookie|api[-_]?key|bearer|credential)/i;
