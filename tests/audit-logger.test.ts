import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AuditLogger } from '../src/audit/logger.js';

describe('AuditLogger', () => {
  it('rotates audit files by size and keeps max backup files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-audit-rotate-'));
    const filePath = join(root, 'audit.log');

    const logger = new AuditLogger({
      enabled: true,
      filePath,
      maxEventBytes: 10_000,
      maxFileBytes: 280,
      maxFiles: 2,
      service: 'dynamic-mcp-test',
      serviceVersion: 'test'
    });

    for (let idx = 0; idx < 12; idx += 1) {
      await logger.log({
        action: 'dynamic.tool.update',
        actor: 'tester',
        result: 'success',
        details: {
          iteration: idx,
          marker: 'rotation-check'
        }
      });
    }

    const files = await readdir(root);
    expect(files).toContain('audit.log');
    expect(files).toContain('audit.log.1');
    expect(files).toContain('audit.log.2');
    expect(files).not.toContain('audit.log.3');
  });

  it('truncates oversized events to stay within event budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-audit-truncate-'));
    const filePath = join(root, 'audit.log');

    const logger = new AuditLogger({
      enabled: true,
      filePath,
      maxEventBytes: 140,
      maxFileBytes: 10_000,
      maxFiles: 2,
      service: 'dynamic-mcp-test',
      serviceVersion: 'test'
    });

    await logger.log({
      action: 'dynamic.tool.create',
      actor: 'tester',
      result: 'success',
      details: {
        payload: 'x'.repeat(400)
      }
    });

    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content.trim()) as {
      details?: {
        truncated?: boolean;
      };
    };

    expect(parsed.details?.truncated).toBe(true);
  });

  it('flush waits for queued writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-audit-flush-'));
    const filePath = join(root, 'audit.log');

    const logger = new AuditLogger({
      enabled: true,
      filePath,
      maxEventBytes: 10_000,
      maxFileBytes: 10_000,
      maxFiles: 2,
      service: 'dynamic-mcp-test',
      serviceVersion: 'test'
    });

    void logger.log({
      action: 'dynamic.tool.create',
      actor: 'tester',
      result: 'success'
    });
    void logger.log({
      action: 'dynamic.tool.update',
      actor: 'tester',
      result: 'success'
    });

    await logger.flush();

    const content = await readFile(filePath, 'utf8');
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBe(2);
  });

  it('redacts sensitive keys in audit details', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-audit-redact-'));
    const filePath = join(root, 'audit.log');

    const logger = new AuditLogger({
      enabled: true,
      filePath,
      maxEventBytes: 10_000,
      maxFileBytes: 10_000,
      maxFiles: 2,
      service: 'dynamic-mcp-test',
      serviceVersion: 'test'
    });

    await logger.log({
      action: 'http.auth',
      actor: 'tester',
      result: 'denied',
      details: {
        token: 'abc',
        nested: {
          api_key: 'xyz',
          normal: 'ok'
        },
        list: [
          {
            password: '123'
          }
        ],
        reason: 'missing bearer'
      }
    });

    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content.trim()) as {
      details?: {
        token?: string;
        nested?: {
          api_key?: string;
          normal?: string;
        };
        list?: Array<{
          password?: string;
        }>;
        reason?: string;
      };
    };

    expect(parsed.details?.token).toBe('[REDACTED]');
    expect(parsed.details?.nested?.api_key).toBe('[REDACTED]');
    expect(parsed.details?.nested?.normal).toBe('ok');
    expect(parsed.details?.list?.[0]?.password).toBe('[REDACTED]');
    expect(parsed.details?.reason).toBe('missing bearer');
  });

  it('skips logging when disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-audit-disabled-'));
    const filePath = join(root, 'audit.log');

    const logger = new AuditLogger({
      enabled: false,
      filePath,
      maxEventBytes: 10_000,
      maxFileBytes: 10_000,
      maxFiles: 2,
      service: 'dynamic-mcp-test',
      serviceVersion: 'test'
    });

    await logger.log({
      action: 'dynamic.tool.create',
      actor: 'tester',
      result: 'success'
    });

    const files = await readdir(root);
    expect(files).not.toContain('audit.log');
  });

  it('isEnabled returns correct status', () => {
    const enabledLogger = new AuditLogger({
      enabled: true,
      filePath: '/tmp/test-audit.log',
      maxEventBytes: 10_000,
      maxFileBytes: 10_000,
      maxFiles: 2,
      service: 'dynamic-mcp-test',
      serviceVersion: 'test'
    });
    expect(enabledLogger.isEnabled()).toBe(true);

    const disabledLogger = new AuditLogger({
      enabled: false,
      filePath: '/tmp/test-audit.log',
      maxEventBytes: 10_000,
      maxFileBytes: 10_000,
      maxFiles: 2,
      service: 'dynamic-mcp-test',
      serviceVersion: 'test'
    });
    expect(disabledLogger.isEnabled()).toBe(false);
  });

  it('includes service metadata in log entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-audit-meta-'));
    const filePath = join(root, 'audit.log');

    const logger = new AuditLogger({
      enabled: true,
      filePath,
      maxEventBytes: 10_000,
      maxFileBytes: 10_000,
      maxFiles: 2,
      service: 'my-service',
      serviceVersion: '2.0.0'
    });

    await logger.log({
      action: 'test.action',
      actor: 'tester',
      target: 'some-target',
      result: 'success'
    });

    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content.trim()) as {
      timestamp: string;
      service: string;
      serviceVersion: string;
      action: string;
      actor: string;
      target: string;
      result: string;
    };

    expect(parsed.timestamp).toBeDefined();
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    expect(parsed.service).toBe('my-service');
    expect(parsed.serviceVersion).toBe('2.0.0');
    expect(parsed.action).toBe('test.action');
    expect(parsed.actor).toBe('tester');
    expect(parsed.target).toBe('some-target');
    expect(parsed.result).toBe('success');
  });

  it('writes multiple events as JSONL (one JSON per line)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-audit-jsonl-'));
    const filePath = join(root, 'audit.log');

    const logger = new AuditLogger({
      enabled: true,
      filePath,
      maxEventBytes: 10_000,
      maxFileBytes: 100_000,
      maxFiles: 2,
      service: 'dynamic-mcp-test',
      serviceVersion: 'test'
    });

    await logger.log({ action: 'event.one', actor: 'a', result: 'success' });
    await logger.log({ action: 'event.two', actor: 'b', result: 'error' });
    await logger.log({ action: 'event.three', actor: 'c', result: 'denied' });

    const content = await readFile(filePath, 'utf8');
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(3);

    const first = JSON.parse(lines[0]) as { action: string };
    const second = JSON.parse(lines[1]) as { action: string };
    const third = JSON.parse(lines[2]) as { action: string };
    expect(first.action).toBe('event.one');
    expect(second.action).toBe('event.two');
    expect(third.action).toBe('event.three');
  });

  it('redacts credential and bearer keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-audit-redact-ext-'));
    const filePath = join(root, 'audit.log');

    const logger = new AuditLogger({
      enabled: true,
      filePath,
      maxEventBytes: 10_000,
      maxFileBytes: 10_000,
      maxFiles: 2,
      service: 'dynamic-mcp-test',
      serviceVersion: 'test'
    });

    await logger.log({
      action: 'test.redact',
      actor: 'tester',
      result: 'success',
      details: {
        credential: 'my-secret',
        bearer: 'token-value',
        secret: 'hidden',
        authorization: 'Bearer xxx',
        cookie: 'session=abc',
        apiKey: 'key-123',
        api_key: 'key-456',
        normal: 'visible'
      }
    });

    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(content.trim()) as {
      details: Record<string, string>;
    };

    expect(parsed.details.credential).toBe('[REDACTED]');
    expect(parsed.details.bearer).toBe('[REDACTED]');
    expect(parsed.details.secret).toBe('[REDACTED]');
    expect(parsed.details.authorization).toBe('[REDACTED]');
    expect(parsed.details.cookie).toBe('[REDACTED]');
    expect(parsed.details.apiKey).toBe('[REDACTED]');
    expect(parsed.details.api_key).toBe('[REDACTED]');
    expect(parsed.details.normal).toBe('visible');
  });

  it('survives a failed write and continues logging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-mcp-audit-chain-'));
    const filePath = join(root, 'audit.log');

    const logger = new AuditLogger({
      enabled: true,
      filePath,
      maxEventBytes: 10_000,
      maxFileBytes: 100_000,
      maxFiles: 2,
      service: 'dynamic-mcp-test',
      serviceVersion: 'test'
    });

    // First normal write
    await logger.log({ action: 'first', actor: 'a', result: 'success' });

    // The chain should keep working even if internal issues happen
    await logger.log({ action: 'second', actor: 'b', result: 'success' });

    await logger.flush();

    const content = await readFile(filePath, 'utf8');
    const lines = content
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(2);
  });
});
