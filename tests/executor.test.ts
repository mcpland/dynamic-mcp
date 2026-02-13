import { describe, expect, it } from 'vitest';

import { DisabledDynamicToolExecutionEngine } from '../src/dynamic/executor.js';
import type { DynamicToolRecord } from '../src/dynamic/spec.js';

describe('DisabledDynamicToolExecutionEngine', () => {
  const sampleTool: DynamicToolRecord = {
    name: 'my.tool',
    description: 'Test tool',
    code: 'return 1;',
    image: 'node:lts-slim',
    timeoutMs: 30_000,
    dependencies: [],
    enabled: true,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    revision: 1
  };

  it('returns an error result indicating no engine is configured', async () => {
    const engine = new DisabledDynamicToolExecutionEngine();
    const result = await engine.execute(sampleTool, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect((result.content[0] as { text: string }).text).toContain('my.tool');
    expect((result.content[0] as { text: string }).text).toContain(
      'no execution engine is configured'
    );
  });

  it('includes the tool name in the error message', async () => {
    const engine = new DisabledDynamicToolExecutionEngine();
    const result = await engine.execute(
      { ...sampleTool, name: 'custom.tool.name' },
      {}
    );

    expect((result.content[0] as { text: string }).text).toContain('custom.tool.name');
  });

  it('ignores args parameter', async () => {
    const engine = new DisabledDynamicToolExecutionEngine();
    const result = await engine.execute(sampleTool, {
      key: 'value',
      nested: { a: 1 }
    });

    expect(result.isError).toBe(true);
  });
});
