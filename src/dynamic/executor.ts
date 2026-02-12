import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { DynamicToolRecord } from './spec.js';

export interface DynamicToolExecutionEngine {
  execute(tool: DynamicToolRecord, args: Record<string, unknown>): Promise<CallToolResult>;
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
