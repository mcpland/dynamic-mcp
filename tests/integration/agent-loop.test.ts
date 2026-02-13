/**
 * Integration test: Agent Loop with ScriptedLLM
 *
 * Simulates a real LLM agent driving the MCP server via a scripted
 * (mock) LLM. This tests the full closed-loop:
 *
 *   MCP client tools/list → feed tools to LLM →
 *   LLM produces tool_use → MCP client tools/call →
 *   tool result fed back to LLM → LLM produces final answer
 *
 * The ScriptedLLM returns pre-programmed responses, making the test
 * deterministic and CI-friendly. The MCP server is real (enterprise profile).
 *
 * Reference: Official MCP Node.js client tutorial pattern.
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
/*  LLM abstraction + Scripted implementation                        */
/* ------------------------------------------------------------------ */

interface ToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

type LLMTextContent = { type: 'text'; text: string };
type LLMToolUseContent = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type LLMContent = LLMTextContent | LLMToolUseContent;

interface LLMResponse {
  content: LLMContent[];
}

interface LLM {
  create(args: { messages: unknown[]; tools: ToolSpec[] }): Promise<LLMResponse>;
}

/**
 * A scripted LLM that returns pre-programmed responses in order.
 * Each call to `create()` pops the next response from the script.
 */
class ScriptedLLM implements LLM {
  private script: LLMResponse[];

  constructor(script: LLMResponse[]) {
    this.script = [...script];
  }

  async create(): Promise<LLMResponse> {
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedLLM: script exhausted – unexpected extra call');
    return next;
  }
}

/* ------------------------------------------------------------------ */
/*  Agent runner (the "agentic loop")                                */
/* ------------------------------------------------------------------ */

interface AgentResult {
  finalText: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  toolResults: unknown[];
}

/**
 * Runs a simplified agent loop:
 * 1. Lists tools from the MCP server
 * 2. Asks the LLM with the user query and available tools
 * 3. If the LLM returns tool_use, calls the MCP server tool and feeds result back
 * 4. Repeats until the LLM returns only text content
 */
async function runAgent(params: {
  client: Client;
  llm: LLM;
  query: string;
  maxTurns?: number;
}): Promise<AgentResult> {
  const { client, llm, query, maxTurns = 10 } = params;

  // 1. List tools
  const toolsResponse = await client.listTools();
  const tools: ToolSpec[] = toolsResponse.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>
  }));

  // 2. Conversation loop
  const messages: unknown[] = [{ role: 'user', content: query }];
  const finalTextParts: string[] = [];
  const toolCalls: AgentResult['toolCalls'] = [];
  const toolResults: unknown[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await llm.create({ messages, tools });

    let didToolCall = false;

    for (const content of response.content) {
      if (content.type === 'text') {
        finalTextParts.push(content.text);
        continue;
      }

      if (content.type === 'tool_use') {
        didToolCall = true;

        // Call the MCP tool
        const toolResult = await client.callTool({
          name: content.name,
          arguments: content.input
        });

        toolCalls.push({ name: content.name, args: content.input });
        toolResults.push(toolResult);

        // Append to conversation (Anthropic-style pattern)
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: content.id,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(toolResult.content)
                }
              ]
            }
          ]
        });

        break; // Continue to next LLM turn with tool result
      }
    }

    if (!didToolCall) break;
  }

  return {
    finalText: finalTextParts.join('\n'),
    toolCalls,
    toolResults
  };
}

/* ------------------------------------------------------------------ */
/*  Test helpers                                                      */
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
    filePath: '/tmp/dynamic-mcp-agent-audit.log',
    maxEventBytes: 10_000,
    maxFileBytes: 100_000,
    maxFiles: 3,
    service: 'dynamic-mcp-agent',
    serviceVersion: 'test'
  });
}

function buildConfig(storeRoot: string): CreateMcpServerOptions {
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
    auditLogger: createTestAuditLogger()
  };
}

async function connectPair(config: CreateMcpServerOptions) {
  const server = await createMcpServer(config);
  const client = new Client({ name: 'agent-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  openedServers.push(server);
  openedClients.push(client);

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe('agent loop with ScriptedLLM', () => {
  it('single tool call: LLM calls dev.echo then produces final answer', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-agent-single-'));
    const { client } = await connectPair(buildConfig(storeRoot));

    const llm = new ScriptedLLM([
      // Turn 1: LLM decides to call dev.echo
      {
        content: [
          {
            type: 'tool_use',
            id: 'call-1',
            name: 'dev.echo',
            input: { message: 'hello agent', uppercase: true }
          }
        ]
      },
      // Turn 2: LLM sees tool result and produces final text
      {
        content: [{ type: 'text', text: 'The echoed message is: HELLO AGENT' }]
      }
    ]);

    const result = await runAgent({ client, llm, query: 'Echo hello agent in uppercase' });

    // Verify tool was called correctly
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      name: 'dev.echo',
      args: { message: 'hello agent', uppercase: true }
    });

    // Verify MCP tool returned correct result
    const toolResult = result.toolResults[0] as { structuredContent: { message: string } };
    expect(toolResult.structuredContent.message).toBe('HELLO AGENT');

    // Verify final text from LLM
    expect(result.finalText).toContain('HELLO AGENT');
  });

  it('multi-step: LLM calls time.now then dev.echo with the time', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-agent-multi-'));
    const { client } = await connectPair(buildConfig(storeRoot));

    const llm = new ScriptedLLM([
      // Turn 1: LLM calls time.now
      {
        content: [
          {
            type: 'tool_use',
            id: 'call-time',
            name: 'time.now',
            input: { timeZone: 'UTC' }
          }
        ]
      },
      // Turn 2: LLM calls dev.echo with the time
      {
        content: [
          {
            type: 'tool_use',
            id: 'call-echo',
            name: 'dev.echo',
            input: { message: 'The current time has been retrieved' }
          }
        ]
      },
      // Turn 3: Final answer
      {
        content: [{ type: 'text', text: 'I checked the time and echoed a confirmation.' }]
      }
    ]);

    const result = await runAgent({
      client,
      llm,
      query: 'What time is it? Confirm by echoing.'
    });

    // Both tools were called
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe('time.now');
    expect(result.toolCalls[1].name).toBe('dev.echo');

    // time.now returned valid data
    const timeResult = result.toolResults[0] as { structuredContent: { iso: string } };
    expect(new Date(timeResult.structuredContent.iso).toISOString()).toBe(
      timeResult.structuredContent.iso
    );

    // Final text
    expect(result.finalText).toContain('time');
  });

  it('no tool call: LLM answers directly without calling any tool', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-agent-notools-'));
    const { client } = await connectPair(buildConfig(storeRoot));

    const llm = new ScriptedLLM([
      // LLM decides it doesn't need any tool
      {
        content: [
          {
            type: 'text',
            text: 'I can answer this directly: the capital of France is Paris.'
          }
        ]
      }
    ]);

    const result = await runAgent({
      client,
      llm,
      query: 'What is the capital of France?'
    });

    expect(result.toolCalls).toHaveLength(0);
    expect(result.toolResults).toHaveLength(0);
    expect(result.finalText).toContain('Paris');
  });

  it('handles tool error gracefully: LLM sees error and reports it', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-agent-error-'));
    const { client } = await connectPair(buildConfig(storeRoot));

    const llm = new ScriptedLLM([
      // Turn 1: LLM calls time.now with invalid timezone
      {
        content: [
          {
            type: 'tool_use',
            id: 'call-bad',
            name: 'time.now',
            input: { timeZone: 'Invalid/Zone' }
          }
        ]
      },
      // Turn 2: LLM acknowledges the error
      {
        content: [
          {
            type: 'text',
            text: 'The timezone was invalid. Please provide a valid IANA timezone.'
          }
        ]
      }
    ]);

    const result = await runAgent({ client, llm, query: 'What time is it in Invalid/Zone?' });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('time.now');

    // The tool returned an error
    const toolResult = result.toolResults[0] as { isError: boolean };
    expect(toolResult.isError).toBe(true);

    // LLM handled it gracefully
    expect(result.finalText).toContain('invalid');
  });

  it('agent creates a dynamic tool, then calls system.health', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-agent-dyncreate-'));
    const { client } = await connectPair(buildConfig(storeRoot));

    const llm = new ScriptedLLM([
      // Turn 1: LLM creates a dynamic tool
      {
        content: [
          {
            type: 'tool_use',
            id: 'call-create',
            name: 'dynamic.tool.create',
            input: {
              tool: {
                name: 'dynamic.agent_created',
                description: 'Created by agent',
                code: 'return { status: "ok" };'
              }
            }
          }
        ]
      },
      // Turn 2: LLM calls system.health to check server status
      {
        content: [
          {
            type: 'tool_use',
            id: 'call-health',
            name: 'system.health',
            input: {}
          }
        ]
      },
      // Turn 3: Final answer
      {
        content: [
          {
            type: 'text',
            text: 'I created the dynamic tool and the server is healthy.'
          }
        ]
      }
    ]);

    const result = await runAgent({ client, llm, query: 'Create a tool and check server health' });

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe('dynamic.tool.create');
    expect(result.toolCalls[1].name).toBe('system.health');

    // Verify the dynamic tool was actually created (side effect)
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === 'dynamic.agent_created')).toBe(true);

    // Verify system.health returned ok
    const healthResult = result.toolResults[1] as {
      structuredContent: { status: string };
    };
    expect(healthResult.structuredContent.status).toBe('ok');

    expect(result.finalText).toContain('healthy');
  });

  it('agent manages full dynamic tool CRUD in a single conversation', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-agent-crud-'));
    const { client } = await connectPair(buildConfig(storeRoot));

    const llm = new ScriptedLLM([
      // Turn 1: Create tool
      {
        content: [
          {
            type: 'tool_use',
            id: 'create',
            name: 'dynamic.tool.create',
            input: {
              tool: {
                name: 'dynamic.crud_demo',
                description: 'CRUD demo',
                code: 'return 1;'
              }
            }
          }
        ]
      },
      // Turn 2: Update tool
      {
        content: [
          {
            type: 'tool_use',
            id: 'update',
            name: 'dynamic.tool.update',
            input: {
              name: 'dynamic.crud_demo',
              expectedRevision: 1,
              patch: { description: 'CRUD demo v2' }
            }
          }
        ]
      },
      // Turn 3: Get tool to verify
      {
        content: [
          {
            type: 'tool_use',
            id: 'get',
            name: 'dynamic.tool.get',
            input: { name: 'dynamic.crud_demo' }
          }
        ]
      },
      // Turn 4: Delete tool
      {
        content: [
          {
            type: 'tool_use',
            id: 'delete',
            name: 'dynamic.tool.delete',
            input: { name: 'dynamic.crud_demo' }
          }
        ]
      },
      // Turn 5: Final answer
      {
        content: [
          {
            type: 'text',
            text: 'Successfully created, updated, verified, and deleted the tool.'
          }
        ]
      }
    ]);

    const result = await runAgent({
      client,
      llm,
      query: 'Demonstrate full CRUD on a dynamic tool'
    });

    expect(result.toolCalls).toHaveLength(4);
    expect(result.toolCalls.map((tc) => tc.name)).toEqual([
      'dynamic.tool.create',
      'dynamic.tool.update',
      'dynamic.tool.get',
      'dynamic.tool.delete'
    ]);

    // All tool calls should have succeeded
    for (const tr of result.toolResults) {
      expect((tr as { isError?: boolean }).isError).not.toBe(true);
    }

    // The get result should show v2 description
    const getResult = result.toolResults[2] as {
      structuredContent: { tool: { description: string; revision: number } };
    };
    expect(getResult.structuredContent.tool.description).toBe('CRUD demo v2');
    expect(getResult.structuredContent.tool.revision).toBe(2);

    // Tool should be gone after delete
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === 'dynamic.crud_demo')).toBe(false);

    expect(result.finalText).toContain('Successfully');
  });

  it('LLM produces mixed content (text + tool_use in same turn)', async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), 'integ-agent-mixed-'));
    const { client } = await connectPair(buildConfig(storeRoot));

    const llm = new ScriptedLLM([
      // Turn 1: LLM produces thinking text + tool call in same response
      {
        content: [
          { type: 'text', text: 'Let me check the server health first...' },
          {
            type: 'tool_use',
            id: 'call-health',
            name: 'system.health',
            input: {}
          }
        ]
      },
      // Turn 2: Final answer
      {
        content: [{ type: 'text', text: 'The server is running fine.' }]
      }
    ]);

    const result = await runAgent({ client, llm, query: 'Is the server ok?' });

    // Both text parts should be captured
    expect(result.finalText).toContain('check the server health');
    expect(result.finalText).toContain('running fine');

    // Tool was called
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('system.health');
  });
});
