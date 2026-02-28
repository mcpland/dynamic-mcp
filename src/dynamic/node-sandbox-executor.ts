import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { DynamicToolExecutionEngine } from './executor.js';
import type { DynamicToolRecord } from './spec.js';

const execFileAsync = promisify(execFile);
const resultMarker = '__DYNAMIC_TOOL_RESULT__';

export interface NodeSandboxDynamicExecutionOptions {
  nodeBinary: string;
  memoryLimit: string;
  maxDependencies: number;
  maxOutputBytes: number;
  maxTimeoutMs: number;
}

export class NodeSandboxDynamicToolExecutionEngine implements DynamicToolExecutionEngine {
  private readonly options: NodeSandboxDynamicExecutionOptions;

  constructor(options: NodeSandboxDynamicExecutionOptions) {
    this.options = options;
  }

  async execute(tool: DynamicToolRecord, args: Record<string, unknown>): Promise<CallToolResult> {
    const startedAt = Date.now();
    const workspace = await mkdtemp(join(tmpdir(), 'dynamic-mcp-node-sandbox-'));

    try {
      this.assertToolAllowed(tool);

      const timeout = Math.min(tool.timeoutMs, this.options.maxTimeoutMs);
      const argsB64 = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');

      await writeFile(join(workspace, 'tool.mjs'), renderToolModule(tool.code), 'utf8');
      await writeFile(join(workspace, 'runner.mjs'), renderRunnerModule(), 'utf8');

      const { stdout, stderr } = await execFileAsync(
        this.options.nodeBinary,
        [
          `--max-old-space-size=${deriveMaxOldSpaceSizeMb(this.options.memoryLimit)}`,
          join(workspace, 'runner.mjs')
        ],
        {
          cwd: workspace,
          timeout,
          env: buildNodeSandboxEnv(argsB64),
          maxBuffer: Math.max(this.options.maxOutputBytes * 3, 1_000_000)
        }
      );

      const output = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim();
      const truncatedOutput = clipText(output, this.options.maxOutputBytes);
      const parsed = parseResult(truncatedOutput);
      const durationMs = Date.now() - startedAt;

      if (!parsed) {
        return {
          content: [
            {
              type: 'text',
              text: [`Dynamic tool: ${tool.name}`, `Duration: ${durationMs}ms`, truncatedOutput]
                .filter(Boolean)
                .join('\n\n')
            }
          ],
          isError: false
        };
      }

      if (!parsed.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: [`Dynamic tool failed: ${tool.name}`, `Duration: ${durationMs}ms`, parsed.error]
                .filter(Boolean)
                .join('\n\n')
            }
          ],
          structuredContent: {
            ok: false,
            error: parsed.error,
            durationMs
          }
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: [`Dynamic tool succeeded: ${tool.name}`, `Duration: ${durationMs}ms`].join('\n')
          }
        ],
        structuredContent: {
          ok: true,
          result: parsed.result,
          durationMs
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Dynamic tool execution error: ${message}`
          }
        ]
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  private assertToolAllowed(tool: DynamicToolRecord): void {
    if (tool.dependencies.length > this.options.maxDependencies) {
      throw new Error(`Dependency count exceeds limit (${this.options.maxDependencies}).`);
    }

    if (tool.dependencies.length > 0) {
      throw new Error(
        'Node sandbox execution does not support dynamic dependencies. Configure MCP_EXECUTION_ENGINE=docker or remove dependencies.'
      );
    }
  }
}

function renderToolModule(code: string): string {
  return `export async function run(args) {\n${code}\n}\n`;
}

function renderRunnerModule(): string {
  return `
import { run } from './tool.mjs';

const marker = '${resultMarker}';

function parseArgs() {
  const encoded = process.env.MCP_DYNAMIC_ARGS_B64;
  if (!encoded) return {};
  try {
    const json = Buffer.from(encoded, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(
    value,
    (key, currentValue) => {
      if (typeof currentValue === 'bigint') {
        return currentValue.toString();
      }

      if (currentValue instanceof Error) {
        return {
          name: currentValue.name,
          message: currentValue.message,
          stack: currentValue.stack
        };
      }

      if (typeof currentValue === 'object' && currentValue !== null) {
        if (seen.has(currentValue)) {
          return '[Circular]';
        }
        seen.add(currentValue);
      }

      return currentValue;
    }
  );
}

try {
  const args = parseArgs();
  const result = await run(args);
  let payload;
  try {
    payload = safeStringify({ ok: true, result });
  } catch {
    payload = JSON.stringify({ ok: true, result: String(result) });
  }

  process.stdout.write('\\n' + marker + payload + '\\n');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const payload = JSON.stringify({ ok: false, error: message });
  process.stdout.write('\\n' + marker + payload + '\\n');
  process.exitCode = 1;
}
`;
}

function parseResult(output: string):
  | {
      ok: true;
      result: unknown;
    }
  | {
      ok: false;
      error: string;
    }
  | null {
  const markerPosition = output.lastIndexOf(resultMarker);
  if (markerPosition < 0) {
    return null;
  }

  const payload = output.slice(markerPosition + resultMarker.length).trim();

  try {
    const parsed = JSON.parse(payload) as {
      ok?: boolean;
      result?: unknown;
      error?: string;
    };

    if (parsed.ok === true) {
      return { ok: true, result: parsed.result };
    }

    return {
      ok: false,
      error: parsed.error ?? 'Unknown dynamic tool error.'
    };
  } catch {
    return null;
  }
}

function clipText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  const buffer = Buffer.from(text, 'utf8');
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n...<truncated>`;
}

function buildNodeSandboxEnv(argsB64: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    MCP_DYNAMIC_ARGS_B64: argsB64
  };

  if (process.env.TZ) {
    env.TZ = process.env.TZ;
  }

  return env;
}

function deriveMaxOldSpaceSizeMb(memoryLimit: string): number {
  const parsedMemoryMb = parseMemoryLimitMb(memoryLimit);
  if (!parsedMemoryMb) {
    return 256;
  }

  const candidate = Math.floor(parsedMemoryMb * 0.75);
  return Math.min(Math.max(candidate, 128), 4096);
}

function parseMemoryLimitMb(memoryLimit: string): number | null {
  const normalized = memoryLimit.trim().toLowerCase();
  const match = normalized.match(/^(\d+)([kmg])?$/);
  if (!match) {
    return null;
  }

  const rawValue = match[1];
  if (!rawValue) {
    return null;
  }

  const value = Number.parseInt(rawValue, 10);
  const unit = match[2] ?? 'm';
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  if (unit === 'g') {
    return value * 1024;
  }

  if (unit === 'k') {
    return Math.max(1, Math.floor(value / 1024));
  }

  return value;
}
