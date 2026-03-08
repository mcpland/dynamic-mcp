import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { DynamicToolRecord } from './spec.js';

export interface DynamicToolExecutionEngine {
  execute(tool: DynamicToolRecord, args: Record<string, unknown>): Promise<CallToolResult>;
}

export function clipText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  const buffer = Buffer.from(text, 'utf8');
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n...<truncated>`;
}

export function formatToolSuccessText(
  toolName: string,
  durationMs: number,
  result: unknown,
  maxBytes: number
): string {
  return [
    `Dynamic tool succeeded: ${toolName}`,
    `Duration: ${durationMs}ms`,
    `Result:\n${clipText(renderToolResult(result), maxBytes)}`
  ].join('\n\n');
}

function renderToolResult(result: unknown): string {
  if (result === undefined) {
    return 'undefined';
  }

  try {
    const serialized = JSON.stringify(result, null, 2);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall through to a lossy string representation.
  }

  try {
    return String(result);
  } catch {
    return '[unrenderable result]';
  }
}

export class DisabledDynamicToolExecutionEngine implements DynamicToolExecutionEngine {
  async execute(tool: DynamicToolRecord): Promise<CallToolResult> {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Dynamic tool ${tool.name} is registered but no execution engine is configured yet.`
        }
      ]
    };
  }
}
