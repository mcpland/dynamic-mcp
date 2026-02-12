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
const dockerImageRegex = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/;

export interface DockerDynamicExecutionOptions {
  dockerBinary: string;
  memoryLimit: string;
  cpuLimit: string;
  maxDependencies: number;
  maxOutputBytes: number;
  maxTimeoutMs: number;
  allowedImages: string[];
  blockedPackages: string[];
}

export class DockerDynamicToolExecutionEngine implements DynamicToolExecutionEngine {
  private readonly options: DockerDynamicExecutionOptions;
  private dockerCheckedAt = 0;
  private dockerAvailable = false;

  constructor(options: DockerDynamicExecutionOptions) {
    this.options = options;
  }

  async execute(tool: DynamicToolRecord, args: Record<string, unknown>): Promise<CallToolResult> {
    const workspace = await mkdtemp(join(tmpdir(), 'dynamic-mcp-tool-'));
    const startedAt = Date.now();

    try {
      await this.ensureDockerAvailable();
      this.assertToolAllowed(tool);

      const dependencies = Object.fromEntries(
        tool.dependencies.map((dependency) => [dependency.name, dependency.version])
      );

      await writeFile(join(workspace, 'tool.mjs'), renderToolModule(tool.code), 'utf8');
      await writeFile(join(workspace, 'runner.mjs'), renderRunnerModule(), 'utf8');
      await writeFile(
        join(workspace, 'package.json'),
        `${JSON.stringify({ type: 'module', dependencies }, null, 2)}\n`,
        'utf8'
      );

      const command =
        tool.dependencies.length > 0
          ? 'npm install --omit=dev --ignore-scripts --no-audit --fund=false --loglevel=error && node runner.mjs'
          : 'node runner.mjs';

      const timeout = Math.min(tool.timeoutMs, this.options.maxTimeoutMs);
      const argsB64 = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');

      const dockerArgs = [
        'run',
        '--rm',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=64m',
        '--security-opt',
        'no-new-privileges',
        '--cap-drop',
        'ALL',
        '--pids-limit',
        '256',
        '--memory',
        this.options.memoryLimit,
        '--cpus',
        this.options.cpuLimit,
        '--network',
        tool.dependencies.length > 0 ? 'bridge' : 'none',
        '--workdir',
        '/workspace',
        '--volume',
        `${workspace}:/workspace`,
        '--user',
        'node',
        '--env',
        `MCP_DYNAMIC_ARGS_B64=${argsB64}`,
        tool.image,
        '/bin/sh',
        '-lc',
        command
      ];

      const { stdout, stderr } = await execFileAsync(this.options.dockerBinary, dockerArgs, {
        timeout,
        maxBuffer: Math.max(this.options.maxOutputBytes * 3, 1_000_000)
      });

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

  private async ensureDockerAvailable(): Promise<void> {
    const now = Date.now();
    if (now - this.dockerCheckedAt < 30_000) {
      if (!this.dockerAvailable) {
        throw new Error('Docker is not available.');
      }

      return;
    }

    this.dockerCheckedAt = now;

    try {
      await execFileAsync(this.options.dockerBinary, ['info'], {
        timeout: 5_000,
        maxBuffer: 200_000
      });
      this.dockerAvailable = true;
    } catch {
      this.dockerAvailable = false;
      throw new Error('Docker is not running or not reachable.');
    }
  }

  private assertToolAllowed(tool: DynamicToolRecord): void {
    if (!dockerImageRegex.test(tool.image)) {
      throw new Error(`Invalid Docker image name: ${tool.image}`);
    }

    if (this.options.allowedImages.length > 0 && !this.options.allowedImages.includes(tool.image)) {
      throw new Error(`Docker image is not allowed by policy: ${tool.image}`);
    }

    if (tool.dependencies.length > this.options.maxDependencies) {
      throw new Error(`Dependency count exceeds limit (${this.options.maxDependencies}).`);
    }

    const blocked = tool.dependencies.find((dependency) =>
      this.options.blockedPackages.includes(dependency.name)
    );

    if (blocked) {
      throw new Error(`Blocked npm package requested: ${blocked.name}`);
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

  process.stdout.write('\n' + marker + payload + '\n');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const payload = JSON.stringify({ ok: false, error: message });
  process.stdout.write('\n' + marker + payload + '\n');
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
