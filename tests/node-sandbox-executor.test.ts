import { describe, expect, it } from 'vitest';

import { NodeSandboxDynamicToolExecutionEngine } from '../src/dynamic/node-sandbox-executor.js';
import type { DynamicToolRecord } from '../src/dynamic/spec.js';

describe('NodeSandboxDynamicToolExecutionEngine', () => {
  const baseTool: DynamicToolRecord = {
    name: 'dynamic.node_sandbox',
    title: 'Node Sandbox',
    description: 'Node sandbox test tool',
    image: 'node:lts-slim',
    timeoutMs: 30_000,
    dependencies: [],
    code: 'return { greeting: `hello ${String(args.name ?? "unknown")}` };',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1
  };

  it('executes tool code with args when no dependencies are declared', async () => {
    const engine = new NodeSandboxDynamicToolExecutionEngine({
      nodeBinary: process.execPath,
      memoryLimit: '512m',
      maxDependencies: 8,
      maxOutputBytes: 200_000,
      maxTimeoutMs: 60_000
    });

    const result = await engine.execute(baseTool, { name: 'world' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      result: {
        greeting: 'hello world'
      }
    });
  });

  it('rejects dependency installation in node sandbox mode', async () => {
    const engine = new NodeSandboxDynamicToolExecutionEngine({
      nodeBinary: process.execPath,
      memoryLimit: '512m',
      maxDependencies: 8,
      maxOutputBytes: 200_000,
      maxTimeoutMs: 60_000
    });

    const result = await engine.execute(
      {
        ...baseTool,
        dependencies: [{ name: 'zod', version: '^4.3.6' }]
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe('text');
    expect((result.content[0] as { text: string }).text).toContain(
      'does not support dynamic dependencies'
    );
  });
});
