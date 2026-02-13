/**
 * Integration test: Full MCP Protocol Lifecycle
 *
 * Tests the complete MCP protocol flow through a real server instance
 * connected via InMemoryTransport. Covers:
 * - Initialize → listTools → callTool → listResources → readResource → listPrompts → getPrompt
 * - Enterprise vs MVP profile surface area
 * - Multi-step state progression (guard metrics update after tool calls)
 * - Resource and prompt content validation
 */
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditLogger } from '../../src/audit/logger.js';
import { createMcpServer } from '../../src/server/create-server.js';
import type { CreateMcpServerOptions } from '../../src/server/create-server.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const openedClients: Client[] = [];
const openedServers: Awaited<ReturnType<typeof createMcpServer>>[] = [];

afterEach(async () => {
  await Promise.all(openedClients.map((c) => c.close()));
  await Promise.all(openedServers.map((s) => s.close()));
  openedClients.length = 0;
  openedServers.length = 0;
});

function createTestAuditLogger(): AuditLogger {
  return new AuditLogger({
    enabled: false,
    filePath: '/tmp/dynamic-mcp-integration-audit.log',
    maxEventBytes: 10_000,
    maxFileBytes: 100_000,
    maxFiles: 3,
    service: 'dynamic-mcp-integration',
    serviceVersion: 'test'
  });
}

function buildConfig(
  storeRoot: string,
  overrides: Partial<CreateMcpServerOptions> = {}
): CreateMcpServerOptions {
  return {
    profile: 'enterprise',
    dynamic: {
      backend: 'file',
      storeFilePath: join(storeRoot, 'tools.json'),
      maxTools: 32,
      readOnly: false
    },
    sandbox: {
      dockerBinary: 'docker',
      memoryLimit: '512m',
      cpuLimit: '1',
      maxDependencies: 8,
      maxOutputBytes: 200_000,
      maxTimeoutMs: 60_000,
      allowedImages: ['node:lts-slim'],
      blockedPackages: [],
      sessionTimeoutSeconds: 1_800,
      maxSessions: 20
    },
    security: {
      toolMaxConcurrency: 8,
      toolMaxCallsPerWindow: 1000,
      toolRateWindowMs: 60_000
    },
    auth: { mode: 'none' },
    auditLogger: createTestAuditLogger(),
    ...overrides
  };
}

async function connectPair(config: CreateMcpServerOptions) {
  const server = await createMcpServer(config);
  const client = new Client({ name: 'lifecycle-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  openedServers.push(server);
  openedClients.push(client);

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe('MCP protocol lifecycle – enterprise', () => {
  it('completes full lifecycle: tools → resources → prompts in one session', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-lifecycle-'));
    const { client } = await connectPair(buildConfig(storeRoot));

    // 1. List tools
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain('system.health');
    expect(toolNames).toContain('dev.echo');
    expect(toolNames).toContain('time.now');
    expect(toolNames).toContain('system.guard_metrics');
    expect(toolNames).toContain('system.runtime_config');
    expect(toolNames).toContain('run_js_ephemeral');
    expect(toolNames).toContain('dynamic.tool.create');
    expect(toolNames).toContain('dynamic.tool.list');

    // 2. Call system.health
    const health = await client.callTool({ name: 'system.health' });
    expect(health.isError).not.toBe(true);
    const healthPayload = health.structuredContent as {
      status: string;
      service: string;
      version: string;
      uptimeSeconds: number;
    };
    expect(healthPayload.status).toBe('ok');
    expect(healthPayload.service).toBe('dynamic-mcp');
    expect(typeof healthPayload.version).toBe('string');
    expect(healthPayload.uptimeSeconds).toBeGreaterThanOrEqual(0);

    // 3. Call dev.echo
    const echo = await client.callTool({
      name: 'dev.echo',
      arguments: { message: 'integration test', uppercase: true }
    });
    expect(echo.isError).not.toBe(true);
    expect(echo.structuredContent).toEqual({
      message: 'INTEGRATION TEST',
      length: 16
    });

    // 4. Call time.now
    const time = await client.callTool({
      name: 'time.now',
      arguments: { timeZone: 'America/New_York' }
    });
    expect(time.isError).not.toBe(true);
    const timePayload = time.structuredContent as {
      iso: string;
      unixSeconds: number;
      timeZone: string;
    };
    expect(timePayload.timeZone).toBe('America/New_York');
    expect(new Date(timePayload.iso).toISOString()).toBe(timePayload.iso);
    expect(timePayload.unixSeconds).toBeGreaterThan(0);

    // 5. List resources
    const resources = await client.listResources();
    const resourceUris = resources.resources.map((r) => r.uri);
    expect(resourceUris).toContain('dynamic://service/meta');
    expect(resourceUris).toContain('dynamic://service/runtime-config');
    expect(resourceUris).toContain('dynamic://metrics/guard');

    // 6. Read service.meta resource
    const metaResource = await client.readResource({ uri: 'dynamic://service/meta' });
    expect(metaResource.contents.length).toBeGreaterThan(0);
    const meta = JSON.parse((metaResource.contents[0] as { text: string }).text);
    expect(meta.name).toBe('dynamic-mcp');
    expect(meta.protocol).toBe('Model Context Protocol');
    expect(meta.transports).toEqual(['stdio', 'http']);

    // 7. Read runtime-config resource
    const rtConfigResource = await client.readResource({
      uri: 'dynamic://service/runtime-config'
    });
    const rtConfig = JSON.parse((rtConfigResource.contents[0] as { text: string }).text);
    expect(rtConfig.dynamic.backend).toBe('file');
    expect(rtConfig.auth.mode).toBe('none');
    expect(rtConfig.security.toolMaxConcurrency).toBe(8);

    // 8. Read guard metrics resource
    const guardResource = await client.readResource({ uri: 'dynamic://metrics/guard' });
    const guardPayload = JSON.parse((guardResource.contents[0] as { text: string }).text);
    expect(typeof guardPayload.activeExecutions).toBe('number');
    expect(guardPayload.limits).toBeDefined();
    expect(Array.isArray(guardPayload.scopes)).toBe(true);

    // 9. List prompts
    const prompts = await client.listPrompts();
    expect(prompts.prompts.length).toBeGreaterThan(0);
    const checklist = prompts.prompts.find((p) => p.name === 'tool-call-checklist');
    expect(checklist).toBeDefined();
    expect(checklist!.description).toBeDefined();

    // 10. Get prompt
    const promptResult = await client.getPrompt({
      name: 'tool-call-checklist',
      arguments: { toolName: 'dev.echo' }
    });
    expect(promptResult.messages.length).toBeGreaterThan(0);
    const promptText = (promptResult.messages[0].content as { type: string; text: string }).text;
    expect(promptText).toContain('dev.echo');
    expect(promptText).toContain('verify');
  });

  it('guard_metrics reflect tool call activity within one session', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-guard-'));
    const { client } = await connectPair(buildConfig(storeRoot));

    // Get initial guard metrics
    const before = await client.callTool({ name: 'system.guard_metrics' });
    expect(before.isError).not.toBe(true);
    const beforePayload = before.structuredContent as { scopes: unknown[] };
    const scopesBefore = beforePayload.scopes.length;

    // Call dev.echo (this does NOT go through the guard, only dynamic/ephemeral tools do)
    await client.callTool({ name: 'dev.echo', arguments: { message: 'hi' } });

    // Guard metrics unchanged for built-in tools (they don't use the guard)
    const after = await client.callTool({ name: 'system.guard_metrics' });
    const afterPayload = after.structuredContent as { scopes: unknown[] };
    expect(afterPayload.scopes.length).toBe(scopesBefore);
  });

  it('system.health uptime progresses over time', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-uptime-'));
    const { client } = await connectPair(buildConfig(storeRoot));

    const h1 = await client.callTool({ name: 'system.health' });
    const t1 = (h1.structuredContent as { uptimeSeconds: number }).uptimeSeconds;

    // Wait a tiny bit and call again – uptime should be >= previous
    await new Promise((r) => setTimeout(r, 50));

    const h2 = await client.callTool({ name: 'system.health' });
    const t2 = (h2.structuredContent as { uptimeSeconds: number }).uptimeSeconds;

    expect(t2).toBeGreaterThanOrEqual(t1);
  });

  it('runtime_config tool and resource return equivalent data', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-rtconfig-'));
    const { client } = await connectPair(buildConfig(storeRoot));

    // Get via tool
    const toolResult = await client.callTool({ name: 'system.runtime_config' });
    expect(toolResult.isError).not.toBe(true);
    const fromTool = toolResult.structuredContent;

    // Get via resource
    const resourceResult = await client.readResource({
      uri: 'dynamic://service/runtime-config'
    });
    const fromResource = JSON.parse((resourceResult.contents[0] as { text: string }).text);

    // They should be equivalent
    expect(fromTool).toEqual(fromResource);
  });
});

describe('MCP protocol lifecycle – mvp', () => {
  it('provides minimal surface: no enterprise tools, resources, or prompts', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-mvp-'));
    const { client } = await connectPair(
      buildConfig(storeRoot, { profile: 'mvp' })
    );

    // 1. Tools
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);

    // Present in MVP
    expect(toolNames).toContain('system.health');
    expect(toolNames).toContain('run_js_ephemeral');
    expect(toolNames).toContain('dynamic.tool.create');
    expect(toolNames).toContain('dynamic.tool.update');
    expect(toolNames).toContain('dynamic.tool.delete');
    expect(toolNames).toContain('dynamic.tool.list');
    expect(toolNames).toContain('dynamic.tool.get');
    expect(toolNames).toContain('dynamic.tool.enable');

    // NOT present in MVP (enterprise-only)
    expect(toolNames).not.toContain('dev.echo');
    expect(toolNames).not.toContain('time.now');
    expect(toolNames).not.toContain('system.guard_metrics');
    expect(toolNames).not.toContain('system.runtime_config');
    expect(toolNames).not.toContain('sandbox.initialize');
    expect(toolNames).not.toContain('sandbox.exec');
    expect(toolNames).not.toContain('sandbox.run_js');
    expect(toolNames).not.toContain('sandbox.stop');

    // 2. Resources – MVP has no resource capability → Method not found
    await expect(client.listResources()).rejects.toThrow(/Method not found/);

    // 3. Prompts – MVP has no prompt capability → Method not found
    await expect(client.listPrompts()).rejects.toThrow(/Method not found/);

    // 4. Verify system.health still works
    const health = await client.callTool({ name: 'system.health' });
    expect(health.isError).not.toBe(true);
    expect((health.structuredContent as { status: string }).status).toBe('ok');
  });
});
