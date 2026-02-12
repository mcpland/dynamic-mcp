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
});
