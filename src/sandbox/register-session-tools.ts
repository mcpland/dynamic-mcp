import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { DynamicDependencySchema } from '../dynamic/spec.js';
import { ensureDockerAvailable, runDocker } from './docker.js';
import { sanitizeContainerId, sanitizeDockerImage, sanitizeShellCommand } from './policy.js';
import { SandboxSessionRegistry } from './session-registry.js';

export interface SessionSandboxOptions {
  dockerBinary: string;
  memoryLimit: string;
  cpuLimit: string;
  maxDependencies: number;
  maxOutputBytes: number;
  maxTimeoutMs: number;
  allowedImages: string[];
  blockedPackages: string[];
  sessionTimeoutSeconds: number;
  maxSessions: number;
}

const sessionRegistry = new SandboxSessionRegistry();
let scavengerHandle: NodeJS.Timeout | null = null;
let cleanupHooksInstalled = false;

const InitializeSchema = {
  image: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional()
};

const ExecSchema = {
  sessionId: z.string(),
  commands: z.array(z.string().min(1)).min(1).max(20),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional()
};

const RunJsSchema = {
  sessionId: z.string(),
  code: z.string().min(1).max(200_000),
  dependencies: z.array(DynamicDependencySchema).max(64).default([]),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional()
};

const StopSchema = {
  sessionId: z.string()
};

export function registerSessionSandboxTools(server: McpServer, options: SessionSandboxOptions): void {
  ensureScavengerStarted(options);
  ensureCleanupHooksInstalled(options);

  server.registerTool(
    'sandbox.session.list',
    {
      title: 'List Sandbox Sessions',
      description: 'List active long-lived sandbox sessions'
    },
    async (): Promise<CallToolResult> => {
      const sessions = sessionRegistry.list();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(sessions, null, 2)
          }
        ],
        structuredContent: { sessions }
      };
    }
  );

  server.registerTool(
    'sandbox.initialize',
    {
      title: 'Initialize Sandbox Session',
      description: 'Create a reusable container session for iterative commands and scripts',
      inputSchema: InitializeSchema
    },
    async ({ image, timeoutMs }): Promise<CallToolResult> => {
      try {
        await ensureDockerAvailable(options.dockerBinary);

        const chosenImage = image ?? options.allowedImages[0] ?? 'node:lts-slim';
        assertImageAllowed(chosenImage, options);

        const sessionId = `mcp-sbx-${randomUUID()}`;
        const timeout = Math.min(timeoutMs ?? options.maxTimeoutMs, options.maxTimeoutMs);

        await runDocker(
          options.dockerBinary,
          [
            'run',
            '-d',
            '--name',
            sessionId,
            '--read-only',
            '--tmpfs',
            '/tmp:rw,noexec,nosuid,size=64m',
            '--tmpfs',
            '/workspace:rw,exec,nosuid,size=256m',
            '--security-opt',
            'no-new-privileges',
            '--cap-drop',
            'ALL',
            '--pids-limit',
            '256',
            '--memory',
            options.memoryLimit,
            '--cpus',
            options.cpuLimit,
            '--network',
            'bridge',
            '--workdir',
            '/workspace',
            '--user',
            'node',
            chosenImage,
            'tail',
            '-f',
            '/dev/null'
          ],
          {
            timeout,
            maxBuffer: options.maxOutputBytes
          }
        );

        const now = new Date().toISOString();
        sessionRegistry.add(
          {
            id: sessionId,
            image: chosenImage,
            createdAt: now,
            lastUsedAt: now
          },
          options.maxSessions
        );

        return {
          content: [
            {
              type: 'text',
              text: `Sandbox session ready: ${sessionId}`
            }
          ],
          structuredContent: {
            sessionId,
            image: chosenImage,
            timeoutMs: options.sessionTimeoutSeconds * 1000
          }
        };
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'sandbox.exec',
    {
      title: 'Execute Shell Commands In Session',
      description: 'Run one or more shell commands in an active sandbox session',
      inputSchema: ExecSchema
    },
    async ({ sessionId, commands, timeoutMs }): Promise<CallToolResult> => {
      try {
        await ensureDockerAvailable(options.dockerBinary);
        assertSessionExists(sessionId);

        const timeout = Math.min(timeoutMs ?? options.maxTimeoutMs, options.maxTimeoutMs);
        const outputs: string[] = [];

        for (const command of commands) {
          const safeCommand = sanitizeShellCommand(command);
          if (!safeCommand) {
            throw new Error('Command rejected by policy.');
          }

          const { stdout, stderr } = await runDocker(
            options.dockerBinary,
            ['exec', sessionId, '/bin/sh', '-lc', safeCommand],
            {
              timeout,
              maxBuffer: options.maxOutputBytes
            }
          );

          outputs.push([`$ ${safeCommand}`, stdout.trim(), stderr.trim()].filter(Boolean).join('\n'));
        }

        sessionRegistry.touch(sessionId);

        return {
          content: [
            {
              type: 'text',
              text: clipText(outputs.join('\n\n'), options.maxOutputBytes)
            }
          ]
        };
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    'sandbox.run_js',
    {
      title: 'Run JavaScript In Session',
      description: 'Install dependencies and run JavaScript in an existing sandbox session',
      inputSchema: RunJsSchema
    },
    async ({ sessionId, code, dependencies, timeoutMs }): Promise<CallToolResult> => {
      const workspace = await mkdtemp(join(tmpdir(), 'dynamic-mcp-session-js-'));

      try {
        await ensureDockerAvailable(options.dockerBinary);
        assertSessionExists(sessionId);
        assertDependenciesAllowed(dependencies, options);

        const dependencyRecord = Object.fromEntries(
          dependencies.map((dependency) => [dependency.name, dependency.version])
        );

        await writeFile(join(workspace, 'index.mjs'), code, 'utf8');
        await writeFile(
          join(workspace, 'package.json'),
          `${JSON.stringify({ type: 'module', dependencies: dependencyRecord }, null, 2)}\n`,
          'utf8'
        );

        await runDocker(options.dockerBinary, ['cp', `${workspace}/.`, `${sessionId}:/workspace`], {
          timeout: 15_000,
          maxBuffer: options.maxOutputBytes
        });

        const timeout = Math.min(timeoutMs ?? options.maxTimeoutMs, options.maxTimeoutMs);
        const command =
          dependencies.length > 0
            ? 'npm install --omit=dev --ignore-scripts --no-audit --fund=false --loglevel=error && node index.mjs'
            : 'node index.mjs';

        const { stdout, stderr } = await runDocker(
          options.dockerBinary,
          ['exec', sessionId, '/bin/sh', '-lc', command],
          {
            timeout,
            maxBuffer: Math.max(options.maxOutputBytes * 2, 1_000_000)
          }
        );

        sessionRegistry.touch(sessionId);

        const output = clipText(`${stdout}${stderr ? `\n${stderr}` : ''}`.trim(), options.maxOutputBytes);
        return {
          content: [
            {
              type: 'text',
              text: output.length > 0 ? output : 'JavaScript execution completed with no output.'
            }
          ]
        };
      } catch (error) {
        return errorResult(error);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  );

  server.registerTool(
    'sandbox.stop',
    {
      title: 'Stop Sandbox Session',
      description: 'Stop and remove a sandbox session container',
      inputSchema: StopSchema
    },
    async ({ sessionId }): Promise<CallToolResult> => {
      try {
        await ensureDockerAvailable(options.dockerBinary);

        const sanitized = sanitizeContainerId(sessionId);
        if (!sanitized) {
          throw new Error(`Invalid sandbox session id: ${sessionId}`);
        }

        await runDocker(options.dockerBinary, ['rm', '-f', sanitized], {
          timeout: 15_000,
          maxBuffer: options.maxOutputBytes
        });

        sessionRegistry.remove(sanitized);
        return {
          content: [
            {
              type: 'text',
              text: `Stopped sandbox session: ${sanitized}`
            }
          ]
        };
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}

function ensureScavengerStarted(options: SessionSandboxOptions): void {
  if (scavengerHandle) {
    return;
  }

  scavengerHandle = setInterval(() => {
    sessionRegistry
      .cleanupIdleSessions({
        dockerBinary: options.dockerBinary,
        timeoutMs: options.sessionTimeoutSeconds * 1000
      })
      .catch(() => {
        // Ignore scavenger tick errors.
      });
  }, 60_000);
}

function ensureCleanupHooksInstalled(options: SessionSandboxOptions): void {
  if (cleanupHooksInstalled) {
    return;
  }

  const cleanup = async () => {
    await sessionRegistry.cleanupAll(options.dockerBinary);
  };

  process.on('beforeExit', () => {
    void cleanup();
  });

  process.on('SIGINT', () => {
    void cleanup();
  });

  process.on('SIGTERM', () => {
    void cleanup();
  });

  cleanupHooksInstalled = true;
}

function assertSessionExists(sessionId: string): void {
  const sanitized = sanitizeContainerId(sessionId);
  if (!sanitized) {
    throw new Error(`Invalid sandbox session id: ${sessionId}`);
  }

  const session = sessionRegistry.get(sanitized);
  if (!session) {
    throw new Error(`Sandbox session not found: ${sanitized}`);
  }
}

function assertImageAllowed(image: string, options: SessionSandboxOptions): void {
  const sanitized = sanitizeDockerImage(image);
  if (!sanitized) {
    throw new Error(`Invalid Docker image: ${image}`);
  }

  if (options.allowedImages.length > 0 && !options.allowedImages.includes(sanitized)) {
    throw new Error(`Docker image not allowed: ${sanitized}`);
  }
}

function assertDependenciesAllowed(
  dependencies: Array<{ name: string; version: string }>,
  options: SessionSandboxOptions
): void {
  if (dependencies.length > options.maxDependencies) {
    throw new Error(`Dependency count exceeds limit (${options.maxDependencies}).`);
  }

  const blocked = dependencies.find((dependency) => options.blockedPackages.includes(dependency.name));
  if (blocked) {
    throw new Error(`Blocked npm package requested: ${blocked.name}`);
  }
}

function errorResult(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: error instanceof Error ? error.message : String(error)
      }
    ]
  };
}

function clipText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  const buffer = Buffer.from(text, 'utf8');
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n...<truncated>`;
}
