/**
 * Integration test: HTTP MCP Session Lifecycle
 *
 * Tests the full MCP protocol over the actual HTTP transport:
 * - Initialize session via StreamableHTTPClientTransport
 * - List tools and call tools over HTTP
 * - Multiple concurrent sessions
 * - Session termination
 * - Metrics reflect session activity
 */
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditLogger } from '../../src/audit/logger.js';
import { startHttpTransport } from '../../src/transports/http.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const openHandles: Array<{ stop: () => Promise<void> }> = [];
const openClients: Client[] = [];

afterEach(async () => {
  for (const c of openClients) {
    try {
      await c.close();
    } catch {
      /* ignore */
    }
  }
  openClients.length = 0;

  while (openHandles.length > 0) {
    const h = openHandles.pop();
    if (h) await h.stop();
  }
});

function createTestAuditLogger(): AuditLogger {
  return new AuditLogger({
    enabled: false,
    filePath: '/tmp/dynamic-mcp-http-integ-audit.log',
    maxEventBytes: 10_000,
    maxFileBytes: 100_000,
    maxFiles: 3,
    service: 'dynamic-mcp-http-integ',
    serviceVersion: 'test'
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') {
        s.close();
        reject(new Error('Failed to get port'));
        return;
      }
      const port = addr.port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function buildHttpServerOptions(storeRoot: string) {
  return {
    profile: 'enterprise' as const,
    dynamic: {
      backend: 'file' as const,
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
    auth: { mode: 'none' as const },
    auditLogger: createTestAuditLogger()
  };
}

async function startServer(storeRoot: string, port: number) {
  const handle = await startHttpTransport(
    {
      host: '127.0.0.1',
      port,
      path: '/mcp',
      sessionTtlSeconds: 1800,
      maxRequestBytes: 1_000_000
    },
    buildHttpServerOptions(storeRoot)
  );
  openHandles.push(handle);
  return handle;
}

async function connectHttpClient(port: number): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`)
  );
  const client = new Client({ name: 'http-integ-test', version: '1.0.0' });
  await client.connect(transport);
  openClients.push(client);
  return client;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe('HTTP MCP session lifecycle', () => {
  it('initializes session, lists tools, and calls tools over HTTP', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-http-basic-'));
    const port = await getFreePort();
    await startServer(storeRoot, port);

    const client = await connectHttpClient(port);

    // List tools – should contain enterprise tools
    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain('system.health');
    expect(toolNames).toContain('dev.echo');
    expect(toolNames).toContain('time.now');
    expect(toolNames).toContain('dynamic.tool.create');

    // Call system.health
    const health = await client.callTool({ name: 'system.health' });
    expect(health.isError).not.toBe(true);
    expect((health.structuredContent as { status: string }).status).toBe('ok');

    // Call dev.echo
    const echo = await client.callTool({
      name: 'dev.echo',
      arguments: { message: 'over http', uppercase: true }
    });
    expect(echo.isError).not.toBe(true);
    expect(echo.structuredContent).toEqual({
      message: 'OVER HTTP',
      length: 9
    });

    // Call time.now
    const time = await client.callTool({
      name: 'time.now',
      arguments: { timeZone: 'UTC' }
    });
    expect(time.isError).not.toBe(true);
    const timePayload = time.structuredContent as { iso: string; timeZone: string };
    expect(timePayload.timeZone).toBe('UTC');
    expect(new Date(timePayload.iso).toISOString()).toBe(timePayload.iso);
  });

  it('supports multiple concurrent sessions over HTTP', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-http-multi-'));
    const port = await getFreePort();
    await startServer(storeRoot, port);

    // Connect two independent clients
    const client1 = await connectHttpClient(port);
    const client2 = await connectHttpClient(port);

    // Both can list tools independently
    const tools1 = await client1.listTools();
    const tools2 = await client2.listTools();
    expect(tools1.tools.length).toBeGreaterThan(0);
    expect(tools2.tools.length).toBeGreaterThan(0);

    // Both can call tools
    const echo1 = await client1.callTool({
      name: 'dev.echo',
      arguments: { message: 'session1' }
    });
    const echo2 = await client2.callTool({
      name: 'dev.echo',
      arguments: { message: 'session2' }
    });
    expect(echo1.isError).not.toBe(true);
    expect(echo2.isError).not.toBe(true);
    expect((echo1.structuredContent as { message: string }).message).toBe('session1');
    expect((echo2.structuredContent as { message: string }).message).toBe('session2');
  });

  it('metrics endpoint reflects session creation', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-http-metrics-'));
    const port = await getFreePort();
    await startServer(storeRoot, port);

    // Check metrics before any session
    const metricsBefore = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(metricsBefore.status).toBe(200);
    const textBefore = await metricsBefore.text();
    expect(textBefore).toContain('dynamic_mcp_http_sessions_created_total 0');

    // Create a session
    const client = await connectHttpClient(port);
    await client.listTools(); // Ensure session is fully initialized

    // Check metrics after session
    const metricsAfter = await fetch(`http://127.0.0.1:${port}/metrics`);
    const textAfter = await metricsAfter.text();
    expect(textAfter).toContain('dynamic_mcp_http_sessions_active 1');
    expect(textAfter).toContain('dynamic_mcp_http_sessions_created_total 1');
  });

  it('health and readiness probes work alongside MCP sessions', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-http-probes-'));
    const port = await getFreePort();
    await startServer(storeRoot, port);

    // Probes work before any session
    const live = await fetch(`http://127.0.0.1:${port}/livez`);
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toMatchObject({ status: 'ok' });

    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ status: 'ready' });

    // Create MCP session
    const client = await connectHttpClient(port);
    await client.callTool({ name: 'system.health' });

    // Probes still work during active sessions
    const live2 = await fetch(`http://127.0.0.1:${port}/livez`);
    expect(live2.status).toBe(200);

    const ready2 = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready2.status).toBe(200);
  });

  it('creates and manages dynamic tools over HTTP session', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-http-dyn-'));
    const port = await getFreePort();
    await startServer(storeRoot, port);

    const client = await connectHttpClient(port);

    // Create a dynamic tool
    const createResult = await client.callTool({
      name: 'dynamic.tool.create',
      arguments: {
        tool: {
          name: 'dynamic.http_tool',
          description: 'Created over HTTP',
          code: 'return { result: "http" };'
        }
      }
    });
    expect(createResult.isError).not.toBe(true);

    // Verify it appears in tools list
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === 'dynamic.http_tool')).toBe(true);

    // Get the tool details
    const getResult = await client.callTool({
      name: 'dynamic.tool.get',
      arguments: { name: 'dynamic.http_tool' }
    });
    expect(getResult.isError).not.toBe(true);
    const tool = getResult.structuredContent as {
      tool: { name: string; description: string };
    };
    expect(tool.tool.description).toBe('Created over HTTP');

    // Delete it
    const deleteResult = await client.callTool({
      name: 'dynamic.tool.delete',
      arguments: { name: 'dynamic.http_tool' }
    });
    expect(deleteResult.isError).not.toBe(true);

    // Verify removed
    const toolsAfter = await client.listTools();
    expect(toolsAfter.tools.some((t) => t.name === 'dynamic.http_tool')).toBe(false);
  });

  it('propagates dynamic tool changes across active HTTP sessions', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-http-cross-session-'));
    const port = await getFreePort();
    await startServer(storeRoot, port);

    const clientA = await connectHttpClient(port);
    const clientB = await connectHttpClient(port);

    await clientA.listTools();
    await clientB.listTools();

    const toolName = 'dynamic.cross_session_sync';
    const createResult = await clientA.callTool({
      name: 'dynamic.tool.create',
      arguments: {
        tool: {
          name: toolName,
          description: 'Cross-session synchronization test tool',
          code: 'return { synced: true };'
        }
      }
    });
    expect(createResult.isError).not.toBe(true);

    let visibleInB = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const toolsB = await clientB.listTools();
      visibleInB = toolsB.tools.some((tool) => tool.name === toolName);
      if (visibleInB) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(visibleInB).toBe(true);

    const deleteResult = await clientB.callTool({
      name: 'dynamic.tool.delete',
      arguments: { name: toolName }
    });
    expect(deleteResult.isError).not.toBe(true);

    let removedInA = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const toolsA = await clientA.listTools();
      removedInA = !toolsA.tools.some((tool) => tool.name === toolName);
      if (removedInA) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(removedInA).toBe(true);
  });

  it('reads resources and prompts over HTTP session', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-http-res-'));
    const port = await getFreePort();
    await startServer(storeRoot, port);

    const client = await connectHttpClient(port);

    // List resources
    const resources = await client.listResources();
    expect(resources.resources.length).toBeGreaterThan(0);
    expect(resources.resources.map((r) => r.uri)).toContain('dynamic://service/meta');

    // Read a resource
    const meta = await client.readResource({ uri: 'dynamic://service/meta' });
    const metaParsed = JSON.parse((meta.contents[0] as { text: string }).text);
    expect(metaParsed.name).toBe('dynamic-mcp');

    // List prompts
    const prompts = await client.listPrompts();
    expect(prompts.prompts.some((p) => p.name === 'tool-call-checklist')).toBe(true);

    // Get a prompt
    const prompt = await client.getPrompt({
      name: 'tool-call-checklist',
      arguments: { toolName: 'system.health' }
    });
    expect(prompt.messages.length).toBeGreaterThan(0);
    expect(
      (prompt.messages[0].content as { text: string }).text
    ).toContain('system.health');
  });

  it('security headers are present on MCP endpoint responses', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-http-headers-'));
    const port = await getFreePort();
    await startServer(storeRoot, port);

    // Send a POST to /mcp (not a valid initialize, but we get a response with headers)
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 })
    });

    // Security headers should be present regardless of MCP validity
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});
