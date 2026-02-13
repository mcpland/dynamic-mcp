import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AuditLogger } from '../src/audit/logger.js';
import { createMcpServer } from '../src/server/create-server.js';

const openedClients: Client[] = [];
const openedServers: Awaited<ReturnType<typeof createMcpServer>>[] = [];

afterEach(async () => {
  await Promise.all(openedClients.map((client) => client.close()));
  await Promise.all(openedServers.map((server) => server.close()));
  openedClients.length = 0;
  openedServers.length = 0;
});

describe('createMcpServer', () => {
  it('registers tools and executes dev.echo', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-server-test-'));
    const server = await createMcpServer({
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
      auth: {
        mode: 'none'
      },
      auditLogger: createTestAuditLogger()
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(toolNames).toContain('system.health');
    expect(toolNames).toContain('system.guard_metrics');
    expect(toolNames).toContain('system.runtime_config');
    expect(toolNames).toContain('dev.echo');
    expect(toolNames).toContain('time.now');
    expect(toolNames).toContain('run_js_ephemeral');
    expect(toolNames).toContain('sandbox.initialize');
    expect(toolNames).toContain('sandbox.exec');
    expect(toolNames).toContain('sandbox.run_js');
    expect(toolNames).toContain('sandbox.stop');

    const result = await client.callTool({
      name: 'dev.echo',
      arguments: {
        message: 'hello mcp',
        uppercase: true
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      message: 'HELLO MCP',
      length: 9
    });

    const runtimeConfig = await client.callTool({
      name: 'system.runtime_config'
    });
    expect(runtimeConfig.isError).not.toBe(true);
    expect(runtimeConfig.structuredContent).toMatchObject({
      dynamic: {
        backend: 'file',
        readOnly: false,
        adminTokenConfigured: false
      },
      auth: {
        mode: 'none',
        jwtConfigured: false
      }
    });
  });

  it('keeps the default mvp profile surface minimal', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-server-mvp-test-'));
    const server = await createMcpServer({
      profile: 'mvp',
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
      auth: {
        mode: 'none'
      },
      auditLogger: createTestAuditLogger()
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(toolNames).toContain('system.health');
    expect(toolNames).toContain('dynamic.tool.create');
    expect(toolNames).toContain('dynamic.tool.update');
    expect(toolNames).toContain('run_js_ephemeral');
    expect(toolNames).not.toContain('dev.echo');
    expect(toolNames).not.toContain('time.now');
    expect(toolNames).not.toContain('system.guard_metrics');
    expect(toolNames).not.toContain('system.runtime_config');
    expect(toolNames).not.toContain('sandbox.initialize');

    const health = await client.callTool({
      name: 'system.health'
    });
    expect(health.isError).not.toBe(true);
    expect(health.structuredContent).toMatchObject({
      status: 'ok',
      service: 'dynamic-mcp'
    });
  });

  it('time.now returns valid time for default UTC', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-server-time-'));
    const server = await createMcpServer(buildEnterpriseConfig(storeRoot));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'time.now',
      arguments: {}
    });

    expect(result.isError).not.toBe(true);
    const output = result.structuredContent as {
      iso: string;
      unixSeconds: number;
      timeZone: string;
    };
    expect(output.timeZone).toBe('UTC');
    expect(output.iso).toBeDefined();
    expect(output.unixSeconds).toBeGreaterThan(0);
    expect(new Date(output.iso).toISOString()).toBe(output.iso);
  });

  it('time.now returns error for invalid timezone', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-server-time-invalid-'));
    const server = await createMcpServer(buildEnterpriseConfig(storeRoot));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'time.now',
      arguments: { timeZone: 'Invalid/NotReal' }
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/invalid/i);
  });

  it('time.now accepts specific timezone', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-server-time-tz-'));
    const server = await createMcpServer(buildEnterpriseConfig(storeRoot));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'time.now',
      arguments: { timeZone: 'Asia/Shanghai' }
    });

    expect(result.isError).not.toBe(true);
    const output = result.structuredContent as { timeZone: string };
    expect(output.timeZone).toBe('Asia/Shanghai');
  });

  it('system.health returns uptime and version', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-server-health-'));
    const server = await createMcpServer(buildEnterpriseConfig(storeRoot));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'system.health' });

    expect(result.isError).not.toBe(true);
    const output = result.structuredContent as {
      status: string;
      service: string;
      version: string;
      uptimeSeconds: number;
    };
    expect(output.status).toBe('ok');
    expect(output.service).toBe('dynamic-mcp');
    expect(typeof output.version).toBe('string');
    expect(output.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('system.guard_metrics returns guard snapshot', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-server-guard-'));
    const server = await createMcpServer(buildEnterpriseConfig(storeRoot));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'system.guard_metrics' });

    expect(result.isError).not.toBe(true);
    const output = result.structuredContent as {
      activeExecutions: number;
      limits: {
        maxConcurrency: number;
        maxCallsPerWindow: number;
        windowMs: number;
      };
      scopes: unknown[];
    };
    expect(output.activeExecutions).toBe(0);
    expect(output.limits.maxConcurrency).toBeGreaterThan(0);
    expect(output.limits.maxCallsPerWindow).toBeGreaterThan(0);
    expect(output.limits.windowMs).toBeGreaterThan(0);
    expect(Array.isArray(output.scopes)).toBe(true);
  });

  it('enterprise profile registers resources', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-server-resources-'));
    const server = await createMcpServer(buildEnterpriseConfig(storeRoot));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const resources = await client.listResources();
    const resourceUris = resources.resources.map((r) => r.uri);

    expect(resourceUris).toContain('dynamic://service/meta');
    expect(resourceUris).toContain('dynamic://service/runtime-config');
    expect(resourceUris).toContain('dynamic://metrics/guard');
  });

  it('enterprise profile registers prompts', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-server-prompts-'));
    const server = await createMcpServer(buildEnterpriseConfig(storeRoot));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.some((p) => p.name === 'tool-call-checklist')).toBe(true);
  });

  it('enterprise profile registers all dynamic management tools', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-server-dyn-tools-'));
    const server = await createMcpServer(buildEnterpriseConfig(storeRoot));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((t) => t.name);

    expect(toolNames).toContain('dynamic.tool.list');
    expect(toolNames).toContain('dynamic.tool.get');
    expect(toolNames).toContain('dynamic.tool.create');
    expect(toolNames).toContain('dynamic.tool.update');
    expect(toolNames).toContain('dynamic.tool.delete');
    expect(toolNames).toContain('dynamic.tool.enable');
  });

  it('service.meta resource returns metadata', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-server-meta-'));
    const server = await createMcpServer(buildEnterpriseConfig(storeRoot));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const resource = await client.readResource({
      uri: 'dynamic://service/meta'
    });

    expect(resource.contents.length).toBeGreaterThan(0);
    const content = resource.contents[0];
    expect(content.mimeType).toBe('application/json');
    const parsed = JSON.parse((content as { text: string }).text);
    expect(parsed.name).toBe('dynamic-mcp');
    expect(parsed.protocol).toBe('Model Context Protocol');
  });

  it('runtime_config resource returns sanitized config', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-server-rtconfig-'));
    const server = await createMcpServer(buildEnterpriseConfig(storeRoot));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const resource = await client.readResource({
      uri: 'dynamic://service/runtime-config'
    });

    expect(resource.contents.length).toBeGreaterThan(0);
    const parsed = JSON.parse((resource.contents[0] as { text: string }).text);
    expect(parsed.dynamic).toBeDefined();
    expect(parsed.auth).toBeDefined();
    expect(parsed.security).toBeDefined();
    expect(parsed.sandbox).toBeDefined();
    expect(parsed.audit).toBeDefined();
  });

  it('dev.echo echoes message without uppercase', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'dynamic-mcp-server-echo-lower-'));
    const server = await createMcpServer(buildEnterpriseConfig(storeRoot));
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    openedServers.push(server);
    openedClients.push(client);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'dev.echo',
      arguments: { message: 'Hello World' }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      message: 'Hello World',
      length: 11
    });
  });
});

function createTestAuditLogger(): AuditLogger {
  return new AuditLogger({
    enabled: false,
    filePath: '/tmp/dynamic-mcp-test-audit.log',
    maxEventBytes: 10_000,
    maxFileBytes: 100_000,
    maxFiles: 3,
    service: 'dynamic-mcp-test',
    serviceVersion: 'test'
  });
}

function buildEnterpriseConfig(storeRoot: string) {
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
    auth: {
      mode: 'none' as const
    },
    auditLogger: createTestAuditLogger()
  };
}
