import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { DynamicToolExecutionEngine } from './executor.js';
import type { DynamicToolRecord } from './spec.js';

const execFileAsync = promisify(execFile);
const resultMarker = '__DYNAMIC_TOOL_RESULT__';
const dockerImageRegex = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/;
const workspaceTmpfsMount = '/workspace:rw,exec,nosuid,size=256m';
const workspaceVolumePrefix = 'dynamic-mcp-tool-';

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
    const startedAt = Date.now();

    try {
      await this.ensureDockerAvailable();
      this.assertToolAllowed(tool);

      const dependencies = Object.fromEntries(
        tool.dependencies.map((dependency) => [dependency.name, dependency.version])
      );
      const toolModule = renderToolModule(tool.code);
      const runnerModule = renderRunnerModule();
      const packageManifest = `${JSON.stringify({ type: 'module', dependencies }, null, 2)}\n`;
      const timeout = Math.min(tool.timeoutMs, this.options.maxTimeoutMs);
      const argsB64 = Buffer.from(JSON.stringify(args), 'utf8').toString('base64');
      const toolB64 = Buffer.from(toolModule, 'utf8').toString('base64');
      const runnerB64 = Buffer.from(runnerModule, 'utf8').toString('base64');
      const packageB64 = Buffer.from(packageManifest, 'utf8').toString('base64');
      const hasDependencies = tool.dependencies.length > 0;

      let stdout = '';
      let stderr = '';
      if (!hasDependencies) {
        const dockerArgs = buildDockerRunArgs({
          memoryLimit: this.options.memoryLimit,
          cpuLimit: this.options.cpuLimit,
          networkMode: 'none',
          runAsUser: 'node',
          mountArgs: ['--tmpfs', workspaceTmpfsMount],
          envArgs: [
            '--env',
            `MCP_DYNAMIC_ARGS_B64=${argsB64}`,
            '--env',
            `MCP_DYNAMIC_TOOL_B64=${toolB64}`,
            '--env',
            `MCP_DYNAMIC_RUNNER_B64=${runnerB64}`,
            '--env',
            `MCP_DYNAMIC_PACKAGE_B64=${packageB64}`
          ],
          image: tool.image,
          command: buildWorkspaceBootstrapCommand({ installDependencies: false })
        });

        ({ stdout, stderr } = await execFileAsync(this.options.dockerBinary, dockerArgs, {
          timeout,
          maxBuffer: Math.max(this.options.maxOutputBytes * 3, 1_000_000)
        }));
      } else {
        const workspaceVolumeName = `${workspaceVolumePrefix}${randomUUID()}`;
        try {
          await execFileAsync(this.options.dockerBinary, ['volume', 'create', workspaceVolumeName], {
            timeout: 10_000,
            maxBuffer: 200_000
          });

          const installArgs = buildDockerRunArgs({
            memoryLimit: this.options.memoryLimit,
            cpuLimit: this.options.cpuLimit,
            networkMode: 'bridge',
            mountArgs: ['--mount', `type=volume,src=${workspaceVolumeName},dst=/workspace`],
            envArgs: [
              '--env',
              `MCP_DYNAMIC_TOOL_B64=${toolB64}`,
              '--env',
              `MCP_DYNAMIC_RUNNER_B64=${runnerB64}`,
              '--env',
              `MCP_DYNAMIC_PACKAGE_B64=${packageB64}`
            ],
            image: tool.image,
            command: buildWorkspaceBootstrapCommand({ installDependencies: true })
          });

          await execFileAsync(this.options.dockerBinary, installArgs, {
            timeout,
            maxBuffer: Math.max(this.options.maxOutputBytes * 2, 1_000_000)
          });

          const runArgs = buildDockerRunArgs({
            memoryLimit: this.options.memoryLimit,
            cpuLimit: this.options.cpuLimit,
            networkMode: 'none',
            runAsUser: 'node',
            mountArgs: [
              '--mount',
              `type=volume,src=${workspaceVolumeName},dst=/workspace,readonly`
            ],
            envArgs: ['--env', `MCP_DYNAMIC_ARGS_B64=${argsB64}`],
            image: tool.image,
            command: 'node /workspace/runner.mjs'
          });

          ({ stdout, stderr } = await execFileAsync(this.options.dockerBinary, runArgs, {
            timeout,
            maxBuffer: Math.max(this.options.maxOutputBytes * 3, 1_000_000)
          }));
        } finally {
          await removeDockerVolume(this.options.dockerBinary, workspaceVolumeName);
        }
      }

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

function buildWorkspaceBootstrapCommand(options: { installDependencies: boolean }): string {
  const lines = [
    'set -eu',
    "printf '%s' \"$MCP_DYNAMIC_TOOL_B64\" | base64 -d > /workspace/tool.mjs",
    "printf '%s' \"$MCP_DYNAMIC_RUNNER_B64\" | base64 -d > /workspace/runner.mjs",
    "printf '%s' \"$MCP_DYNAMIC_PACKAGE_B64\" | base64 -d > /workspace/package.json"
  ];

  if (options.installDependencies) {
    lines.push('npm install --omit=dev --ignore-scripts --no-audit --fund=false --loglevel=error');
  } else {
    lines.push('node /workspace/runner.mjs');
  }

  return lines.join('\n');
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

function buildDockerRunArgs(input: {
  memoryLimit: string;
  cpuLimit: string;
  networkMode: 'none' | 'bridge';
  mountArgs: string[];
  envArgs: string[];
  image: string;
  command: string;
  runAsUser?: string;
}): string[] {
  return [
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
    input.memoryLimit,
    '--cpus',
    input.cpuLimit,
    '--network',
    input.networkMode,
    '--workdir',
    '/workspace',
    ...(input.runAsUser ? ['--user', input.runAsUser] : []),
    ...input.mountArgs,
    ...input.envArgs,
    input.image,
    '/bin/sh',
    '-lc',
    input.command
  ];
}

async function removeDockerVolume(dockerBinary: string, volumeName: string): Promise<void> {
  try {
    await execFileAsync(dockerBinary, ['volume', 'rm', '-f', volumeName], {
      timeout: 10_000,
      maxBuffer: 200_000
    });
  } catch {
    // Ignore best-effort cleanup failures.
  }
}
