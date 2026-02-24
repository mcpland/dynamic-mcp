# Dynamic Tools Guide

## Overview

Dynamic tools are JavaScript functions that can be created, updated, and managed at runtime through the MCP control plane (`dynamic.tool.*` tools). Each tool runs in an isolated Docker container with its own npm dependencies.

## Code Contract

When you create a dynamic tool, the `code` field contains the **body** of an async function. At execution time, the code is wrapped as:

```js
export async function run(args) {
  // your code body here
}
```

The `args` parameter is an object containing whatever arguments the MCP client passes when invoking the tool.

### Return Value

Return any JSON-serializable value. The runner will serialize it and send it back to the MCP client.

```js
// Simple return
return { result: "hello" };

// Return a computed value
const sum = args.a + args.b;
return { sum };

// Return an array
return [1, 2, 3];

// Return a string
return "done";
```

### Error Handling

Throw an error to signal failure:

```js
if (!args.text) {
  throw new Error("Missing required argument: text");
}
return { upper: args.text.toUpperCase() };
```

Uncaught exceptions are caught by the runner and returned as error results to the MCP client.

## Examples

### Basic: Text Processing

```json
{
  "tool": {
    "name": "text.uppercase",
    "description": "Convert input text to uppercase",
    "code": "const { text } = args;\nif (!text) throw new Error('text is required');\nreturn { upper: String(text).toUpperCase() };",
    "dependencies": [],
    "image": "node:lts-slim",
    "timeoutMs": 10000
  }
}
```

Invoke:
```json
{ "args": { "text": "hello world" } }
```

Result:
```json
{ "ok": true, "result": { "upper": "HELLO WORLD" } }
```

### With Dependencies

```json
{
  "tool": {
    "name": "data.parse_csv",
    "description": "Parse CSV text into JSON rows",
    "code": "const { parse } = await import('csv-parse/sync');\nconst records = parse(args.csv, { columns: true });\nreturn { rows: records, count: records.length };",
    "dependencies": [
      { "name": "csv-parse", "version": "^5.5.0" }
    ],
    "image": "node:lts-slim",
    "timeoutMs": 30000
  }
}
```

### Async Operations

```js
// HTTP request (no extra dependencies needed in Node.js 18+)
const response = await fetch(args.url);
const data = await response.json();
return { status: response.status, data };
```

### Stateless Computation

```js
// Mathematical computation
const { numbers } = args;
const sum = numbers.reduce((a, b) => a + b, 0);
const avg = sum / numbers.length;
const sorted = [...numbers].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
return { sum, avg, median, count: numbers.length };
```

## Tool Lifecycle

### Create

```
dynamic.tool.create → validates schema → persists to registry → registers as MCP tool → notifies clients
                 → [postgres backend] emits LISTEN/NOTIFY event for other instances
```

After creation, the tool is immediately available for invocation.
In HTTP mode, tool mutations are propagated across active sessions in the same server process.

### Update

```
dynamic.tool.update → validates patch → updates registry → re-registers MCP tool → notifies clients
                 → [postgres backend] emits LISTEN/NOTIFY event for other instances
```

Use `expectedRevision` for safe concurrent updates:

```json
{
  "name": "text.uppercase",
  "patch": {
    "description": "Updated description",
    "timeoutMs": 15000
  },
  "expectedRevision": 3
}
```

If the current revision doesn't match, the update is rejected with a conflict error.

### Enable / Disable

Disabled tools remain in the registry but are unregistered from MCP. Re-enabling re-registers them.

```json
{
  "name": "text.uppercase",
  "enabled": false
}
```

### Delete

Permanently removes the tool from the registry and unregisters it from MCP.

## `run_js_ephemeral`

For one-off code execution that doesn't need to be persisted as a tool:

```json
{
  "code": "return { now: new Date().toISOString(), pid: process.pid };",
  "args": {},
  "dependencies": [],
  "image": "node:lts-slim",
  "timeoutMs": 10000
}
```

This creates a temporary tool record, executes it in a Docker container, and discards it. No tool is registered in the registry.

## Execution Environment

### Container Setup

Each tool execution creates a temporary workspace containing:

| File | Purpose |
|------|---------|
| `tool.mjs` | Your code wrapped in `export async function run(args) { ... }` |
| `runner.mjs` | Execution harness that invokes the tool and formats output |
| `package.json` | Dependencies (if any) |

### Arguments

Arguments are passed via the `MCP_DYNAMIC_ARGS_B64` environment variable (base64-encoded JSON). The runner decodes them and passes them to the `run` function.

### Output Parsing

The runner emits a special marker (`__DYNAMIC_TOOL_RESULT__`) followed by a JSON payload:

- `{ "ok": true, "result": <value> }` — success
- `{ "ok": false, "error": "<message>" }` — failure

If no marker is found in stdout, the raw output is returned as text.

### Network Access

- **No dependencies:** Execution runs with `--network none`.
- **With dependencies:** Runtime is split into two phases:
  - Dependency install phase uses `--network bridge`.
  - Tool execution phase uses `--network none`.

### Limits

| Constraint | Default | Configurable |
|-----------|---------|-------------|
| Memory | 512 MB | `MCP_SANDBOX_MEMORY_LIMIT` |
| CPU | 1 core | `MCP_SANDBOX_CPU_LIMIT` |
| Timeout | 30s (tool), 120s (max) | `tool.timeoutMs`, `MCP_SANDBOX_MAX_TIMEOUT_MS` |
| Dependencies | 32 max | `MCP_SANDBOX_MAX_DEPENDENCIES` |
| Output size | 200 KB | `MCP_SANDBOX_MAX_OUTPUT_BYTES` |
| PIDs | 256 | Hardcoded |

## Tool Name Constraints

- Must match pattern: `^[a-zA-Z][a-zA-Z0-9._:-]{2,63}$`
- 3–64 characters, starts with a letter
- Allowed characters: letters, digits, `.`, `_`, `:`, `-`
- Cannot start with `dynamic.tool.` (reserved prefix)
- Cannot be `run_js_ephemeral` (reserved built-in)

## Admin Token

When `MCP_ADMIN_TOKEN` is set, all `dynamic.tool.*` operations require the `adminToken` field to match. This prevents unauthorized tool modification.

Set `MCP_REQUIRE_ADMIN_TOKEN=true` to fail startup when `MCP_ADMIN_TOKEN` is missing.

## Read-Only Mode

When `MCP_DYNAMIC_READ_ONLY=true`, all write operations (`create`, `update`, `delete`, `enable`) are rejected. Existing tools can still be listed, retrieved, and executed.

## Sandbox Sessions (Enterprise)

Enterprise profile adds long-lived sandbox sessions — persistent Docker containers that can be reused across multiple commands:

1. **Initialize** a session (`sandbox.initialize`) — creates a persistent container
2. **Execute** commands (`sandbox.exec`) or JavaScript (`sandbox.run_js`) in the session
3. **Stop** the session (`sandbox.stop`) when done

Sessions are automatically scavenged after the idle timeout (`MCP_SANDBOX_SESSION_TIMEOUT_SECONDS`). All sessions are cleaned up on process shutdown.

### Session vs Ephemeral Execution

| Aspect | `run_js_ephemeral` / Dynamic Tools | Sandbox Sessions |
|--------|-------------------------------------|------------------|
| Container lifetime | Single execution | Persists across commands |
| State preservation | None | Files persist between calls |
| Use case | Independent computations | Iterative workflows |
| Profile | MVP + Enterprise | Enterprise only |
