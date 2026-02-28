# Architecture

## Overview

dynamic-mcp is a Model Context Protocol (MCP) server built on the [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk). It extends the standard MCP server pattern with a **dynamic tool registry** that allows tools to be created, modified, and executed at runtime using a configurable execution backend (`docker` or `node`).

## Module Structure

```
src/
├── index.ts                         # Entry point: loads config, selects transport, installs shutdown hooks
├── server/
│   └── create-server.ts             # MCP server factory: registers all tools, resources, prompts
├── config/
│   └── runtime.ts                   # Config loader: CLI args + env vars + .env file
├── dynamic/                         # Dynamic tool engine
│   ├── spec.ts                      # Zod schemas and TypeScript types
│   ├── service.ts                   # DynamicToolService: CRUD + runtime registration
│   ├── registry.ts                  # File-based registry (JSON)
│   ├── postgres-registry.ts         # PostgreSQL-based registry
│   ├── postgres-change-sync.ts      # PostgreSQL LISTEN/NOTIFY bridge to in-process change bus
│   ├── registry-port.ts             # Abstract registry interface
│   ├── executor.ts                  # Execution engine interface
│   ├── docker-executor.ts           # Docker-based execution engine
│   ├── node-sandbox-executor.ts     # Node child-process sandbox execution engine
│   ├── change-bus.ts                # In-process dynamic registry change fan-out
│   ├── record-utils.ts              # Tool record utilities
│   └── postgres-pool.ts             # Shared PostgreSQL connection pool
├── transports/
│   ├── stdio.ts                     # Stdio transport wrapper
│   ├── http.ts                      # HTTP/Express transport with sessions
│   └── session-expiry.ts            # HTTP session TTL and sweep logic
├── security/
│   └── guard.ts                     # ToolExecutionGuard: concurrency + rate limiting
├── sandbox/
│   ├── register-session-tools.ts    # Enterprise sandbox session tools
│   ├── docker.ts                    # Docker utility functions
│   ├── session-registry.ts          # In-memory session tracker
│   └── policy.ts                    # Input sanitization policies
├── auth/
│   └── jwt.ts                       # JWT/JWKS authentication verifier
├── audit/
│   └── logger.ts                    # Structured JSONL audit logger
└── lib/
    ├── json-file.ts                 # Atomic JSON file I/O
    └── retry.ts                     # Retry with exponential backoff
```

## Data Flow

### Startup

```
index.ts
  │
  ├── loadRuntimeConfig()          ← CLI args + env vars + .env
  ├── new AuditLogger(...)
  │
  ├── [stdio mode]
  │   ├── createMcpServer(...)     ← registers all tools/resources
  │   ├── startStdioTransport()
  │   └── installShutdownHandlers()
  │
  └── [http mode]
      ├── startHttpTransport(...)  ← Express app with session management
      └── installShutdownHandlers()
```

### MCP Server Creation

`createMcpServer()` is the central factory that wires all components:

```
createMcpServer(options)
  │
  ├── new McpServer("dynamic-mcp")
  ├── Register system.health tool
  │
  ├── [enterprise only]
  │   ├── Register dev.echo, time.now tools
  │   ├── Register service.meta resource
  │   ├── Register service.runtime_config resource
  │   └── Register tool-call-checklist prompt
  │
  ├── Build registry (file or postgres)
  ├── Resolve execution engine (auto/docker/node)
  ├── Build ToolExecutionGuard
  │
  ├── new DynamicToolService(...)
  │   ├── registry.load()                ← load persisted tools
  │   ├── refreshAllRuntimeTools()       ← register enabled tools as MCP tools
  │   └── registerManagementTools()      ← register dynamic.tool.* CRUD tools
  │
  ├── Register run_js_ephemeral tool
  │
  └── [enterprise only]
      ├── Register guard.metrics resource
      ├── Register system.guard_metrics tool
      ├── Register system.runtime_config tool
      └── registerSessionSandboxTools()  ← sandbox.* tools
```

### Dynamic Tool Execution

When a dynamic tool is invoked:

```
MCP client calls tool "my-tool" with { args: {...} }
  │
  ├── ToolExecutionGuard.run("dynamic.exec.my-tool", ...)
  │   ├── Assert rate limit not exceeded
  │   └── Assert concurrency limit not exceeded
  │
  └── Resolved execution engine executes(record, args)
      ├── [docker] two-phase isolated container flow
      │   ├── [if deps] install phase (network=bridge)
      │   └── run phase (network=none)
      └── [node] isolated child process flow (no dynamic dependencies)
```

### HTTP Transport Sessions

Each HTTP client gets an isolated MCP server instance:

```
POST /mcp (no session header, initialize request)
  │
  ├── Authenticate (if JWT enabled)
  ├── createMcpServer(...)           ← fresh server per session
  ├── new StreamableHTTPServerTransport()
  ├── server.connect(transport)
  └── Return session ID in response header

POST /mcp (with mcp-session-id header)
  │
  ├── Authenticate
  ├── Lookup session
  ├── Touch session (update last-seen time)
  └── Forward to session transport

GET /mcp (SSE stream)
  └── Forward to session transport for streaming

DELETE /mcp
  └── Close and remove session

Background sweep timer
  └── Every interval, expire sessions idle > TTL
```

Although each HTTP session has its own MCP server instance, dynamic tool mutations are broadcast in-process so active sessions converge on the same dynamic tool set.

## Registry Backends

### File Registry

- Stores tools in a single JSON file (default: `.dynamic-mcp/tools.json`)
- Atomic writes via temp file + rename
- Suitable for single-instance deployments

### PostgreSQL Registry

- Stores tools in a `dynamic_tools` table within a configurable schema
- Auto-creates schema and table on first load with retry logic
- Optimistic concurrency control via `revision` column
- Shared connection pool (one pool per connection string)
- Suitable for multi-instance / HA deployments

## Profiles

The `profile` setting controls which features are registered:

| Feature | MVP | Enterprise |
|---------|:---:|:----------:|
| Dynamic tool CRUD | Yes | Yes |
| `run_js_ephemeral` | Yes | Yes |
| `system.health` | Yes | Yes |
| Execution guard | Yes | Yes |
| Audit logging | Yes | Yes |
| Sandbox sessions | No | Yes |
| Guard metrics tool/resource | No | Yes |
| Runtime config tool/resource | No | Yes |
| `dev.echo`, `time.now` | No | Yes |
| `service.meta` resource | No | Yes |
| `tool-call-checklist` prompt | No | Yes |

## Graceful Shutdown

On `SIGINT` or `SIGTERM`:

1. Stop transport (close all HTTP sessions or stdio)
2. Close all shared PostgreSQL pools
3. Flush audit logger (ensure pending writes complete)
4. Exit process
