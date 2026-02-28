# API Reference

This document covers all MCP tools, resources, and prompts registered by dynamic-mcp.

## Tools

### Core (both profiles)

#### `system.health`

Return server liveness and uptime info.

**Input:** None

**Output:**
```json
{
  "status": "ok",
  "service": "dynamic-mcp",
  "version": "0.2.0",
  "uptimeSeconds": 3600
}
```

---

#### `dynamic.tool.create`

Create and register a new dynamic tool.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adminToken` | string | If configured | Admin authentication token |
| `tool.name` | string | Yes | Tool name (3–64 chars, must match `^[a-zA-Z][a-zA-Z0-9._:-]{2,63}$`) |
| `tool.title` | string | No | Display title (1–120 chars) |
| `tool.description` | string | Yes | Tool description (1–4000 chars) |
| `tool.code` | string | Yes | JavaScript function body (1–200000 chars) |
| `tool.image` | string | No | Docker image (used by Docker backend, default: `node:lts-slim`) |
| `tool.timeoutMs` | number | No | Execution timeout in ms (1000–120000, default: 30000) |
| `tool.dependencies` | array | No | npm dependencies `[{name, version}]` (max 64) |
| `tool.enabled` | boolean | No | Initial enabled state (default: `true`) |

**Response:** Confirmation with tool metadata (excluding code).

---

#### `dynamic.tool.list`

List all registered dynamic tools.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adminToken` | string | If configured | Admin authentication token |
| `includeCode` | boolean | No | Include source code in response (default: `false`) |

**Response:** Array of tool records with metadata.

---

#### `dynamic.tool.get`

Get one dynamic tool definition by name.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adminToken` | string | If configured | Admin authentication token |
| `name` | string | Yes | Tool name |

**Response:** Full tool record including source code.

---

#### `dynamic.tool.update`

Update an existing dynamic tool definition.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adminToken` | string | If configured | Admin authentication token |
| `name` | string | Yes | Tool name |
| `patch.title` | string | No | New title |
| `patch.description` | string | No | New description |
| `patch.code` | string | No | New code |
| `patch.image` | string | No | New Docker image (used by Docker backend) |
| `patch.timeoutMs` | number | No | New timeout |
| `patch.dependencies` | array | No | New dependencies |
| `patch.enabled` | boolean | No | New enabled state |
| `expectedRevision` | number | No | Optimistic concurrency check |

**Response:** Updated tool metadata.

When `expectedRevision` is provided and does not match the current revision, the operation fails with a conflict error.

---

#### `dynamic.tool.delete`

Delete a dynamic tool and unregister it from MCP.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adminToken` | string | If configured | Admin authentication token |
| `name` | string | Yes | Tool name |
| `expectedRevision` | number | No | Optimistic concurrency check |

---

#### `dynamic.tool.enable`

Enable or disable a dynamic tool at runtime.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adminToken` | string | If configured | Admin authentication token |
| `name` | string | Yes | Tool name |
| `enabled` | boolean | Yes | Target state |
| `expectedRevision` | number | No | Optimistic concurrency check |

---

#### `run_js_ephemeral`

Execute one-off Node.js code in the configured execution backend without persisting a tool.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `code` | string | Yes | JavaScript function body (1–200000 chars) |
| `args` | object | No | Arguments passed to the function (default: `{}`) |
| `image` | string | No | Docker image override (used by Docker backend) |
| `dependencies` | array | No | npm dependencies `[{name, version}]` (max 64) |
| `timeoutMs` | number | No | Timeout in ms (1000–120000) |

**Response:** Execution result or error with duration.

Notes:

- `MCP_EXECUTION_ENGINE=auto` prefers Docker and falls back to Node sandbox when Docker is unavailable.
- In Node sandbox mode, `dependencies` must be empty.

---

### Enterprise Only

#### `sandbox.initialize`

Create a reusable container session for iterative commands and scripts.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adminToken` | string | If configured | Admin authentication token |
| `image` | string | No | Docker image (default: first allowed image) |
| `timeoutMs` | number | No | Startup timeout (1000–120000) |

**Response:**
```json
{
  "sessionId": "mcp-sbx-<uuid>",
  "image": "node:lts-slim",
  "timeoutMs": 1800000
}
```

---

#### `sandbox.exec`

Run one or more shell commands in an active sandbox session.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adminToken` | string | If configured | Admin authentication token |
| `sessionId` | string | Yes | Session ID from `sandbox.initialize` |
| `commands` | string[] | Yes | Shell commands to execute (1–20 commands) |
| `timeoutMs` | number | No | Execution timeout (1000–120000) |

**Response:** Combined stdout/stderr from all commands.

---

#### `sandbox.run_js`

Install dependencies and run JavaScript in an existing sandbox session.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adminToken` | string | If configured | Admin authentication token |
| `sessionId` | string | Yes | Session ID |
| `code` | string | Yes | JavaScript source (1–200000 chars) |
| `dependencies` | array | No | npm dependencies `[{name, version}]` (max 64) |
| `timeoutMs` | number | No | Execution timeout (1000–120000) |

---

#### `sandbox.stop`

Stop and remove a sandbox session container.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adminToken` | string | If configured | Admin authentication token |
| `sessionId` | string | Yes | Session ID |

---

#### `sandbox.session.list`

List active long-lived sandbox sessions.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adminToken` | string | If configured | Admin authentication token |

**Response:** Array of session records with `id`, `image`, `createdAt`, `lastUsedAt`.

---

#### `system.guard_metrics`

Get guard concurrency/rate-limit counters.

**Input:** None

**Output:**
```json
{
  "activeExecutions": 2,
  "limits": {
    "maxConcurrency": 8,
    "maxCallsPerWindow": 300,
    "windowMs": 60000
  },
  "scopes": [
    {
      "scope": "dynamic.exec.my-tool",
      "total": 100,
      "allowed": 98,
      "rejectedRate": 1,
      "rejectedConcurrency": 1,
      "failed": 0
    }
  ]
}
```

---

#### `system.runtime_config`

Return sanitized runtime config snapshot (no secrets).

**Input:** None

**Output:** Configuration snapshot including transport, dynamic, auth, security, sandbox, and audit settings.

---

#### `dev.echo`

Echo user input (for testing/debugging).

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | Message to echo |
| `uppercase` | boolean | No | Convert to uppercase (default: `false`) |

---

#### `time.now`

Return current server time.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `timeZone` | string | No | IANA timezone (default: `UTC`) |

**Output:**
```json
{
  "iso": "2025-01-15T12:00:00.000Z",
  "unixSeconds": 1736942400,
  "timeZone": "UTC"
}
```

---

## Resources (Enterprise Only)

#### `dynamic://service/meta`

Service metadata (name, version, supported transports, protocol).

#### `dynamic://service/runtime-config`

Sanitized runtime configuration snapshot.

#### `dynamic://metrics/guard`

Execution guard metrics (same payload as `system.guard_metrics` tool).

---

## Prompts (Enterprise Only)

#### `tool-call-checklist`

A reusable checklist prompt for reviewing tool calls before invocation.

**Arguments:**
| Field | Type | Description |
|-------|------|-------------|
| `toolName` | string | Name of the tool to review |

**Returns:** A prompt message reminding the caller to verify input schema, expected output schema, and failure handling.
