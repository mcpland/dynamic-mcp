# Security

## Defense in Depth

dynamic-mcp implements multiple security layers to ensure safe execution of untrusted code and controlled access to the server.

## Execution Engine Selection

Execution backend is controlled by `MCP_EXECUTION_ENGINE`:

- `auto` (default): prefers Docker; falls back to Node sandbox when Docker is unavailable
- `docker`: force Docker backend (startup fails if Docker is unavailable)
- `node`: force Node sandbox backend

## Docker Sandbox Isolation

When Docker backend is used, dynamic tool execution runs in a hardened Docker container with the following constraints:

| Constraint | Setting | Purpose |
|-----------|---------|---------|
| Read-only filesystem | `--read-only` | Prevent persistent modifications |
| Writable tmpfs | `--tmpfs /tmp:rw,noexec,nosuid,size=64m` | Limited scratch space, no execution |
| Drop all capabilities | `--cap-drop ALL` | No elevated Linux capabilities |
| No new privileges | `--security-opt no-new-privileges` | Prevent privilege escalation |
| PID limit | `--pids-limit 256` | Prevent fork bombs |
| Memory limit | `--memory 512m` (configurable) | Prevent memory exhaustion |
| CPU limit | `--cpus 1` (configurable) | Prevent CPU starvation |
| Unprivileged user | `--user node` | Run as non-root user |
| Network isolation | `--network none` (runtime phase) | No network access during tool execution |
| Auto-removal | `--rm` | Container removed after execution |

### Network Policy

- Tools with **no dependencies** run directly with `--network none`.
- Tools with **dependencies** use a two-phase flow:
  - install phase (`npm install`) runs with `--network bridge`
  - execution phase (`node runner.mjs`) runs with `--network none`

## Node Sandbox Backend

When Node backend is used, execution runs in a separate Node.js child process with timeout/output limits.

Important limitations:

- This is not a container boundary and should not be treated as equivalent to Docker isolation.
- Dynamic dependency installation is disabled (`dependencies` must be empty).

## Image and Package Controls

### Docker Image Allowlist

Only images listed in `MCP_SANDBOX_ALLOWED_IMAGES` can be used. Default: `node:lts-slim`.

```env
MCP_SANDBOX_ALLOWED_IMAGES=node:lts-slim,node:22-alpine
```

If the allowlist is empty, all images are permitted. Image names are validated against the regex `^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$`.

### npm Package Blocklist

Packages listed in `MCP_SANDBOX_BLOCKED_PACKAGES` cannot be used as dependencies. Default: `child_process,node-pty,npm,pm2`.

```env
MCP_SANDBOX_BLOCKED_PACKAGES=child_process,node-pty,npm,pm2
```

### Dependency Limits

Maximum number of dependencies per tool (default: 32, max: 256).

## Admin Token

When `MCP_ADMIN_TOKEN` is configured, all management operations (`dynamic.tool.create`, `dynamic.tool.update`, `dynamic.tool.delete`, `dynamic.tool.enable`, `dynamic.tool.list`, `dynamic.tool.get`, and sandbox session tools) require the caller to provide a matching `adminToken` field.

Set `MCP_REQUIRE_ADMIN_TOKEN=true` to enforce this at startup. In this mode, the process fails fast if `MCP_ADMIN_TOKEN` is missing.

```env
MCP_ADMIN_TOKEN=your-secret-token
MCP_REQUIRE_ADMIN_TOKEN=true
```

## Read-Only Mode

Setting `MCP_DYNAMIC_READ_ONLY=true` disables all write operations on the tool registry. Tools can still be listed, read, and executed, but no new tools can be created or existing ones modified.

## Optimistic Concurrency Control

Write operations (`update`, `delete`, `enable`) accept an optional `expectedRevision` parameter. When provided, the server verifies the current tool revision matches before applying the change. If a conflict is detected, the operation fails with an error instead of silently overwriting.

This prevents race conditions in multi-client or multi-instance scenarios.

## JWT Authentication (HTTP Mode)

When `MCP_AUTH_MODE=jwt`, JWT is enforced on the MCP endpoint path (`MCP_PATH`, default `/mcp`).

By design, the operational endpoints `/livez`, `/readyz`, and `/metrics` remain unauthenticated so health probes and metrics scrapers can run without bearer tokens.

```env
MCP_AUTH_MODE=jwt
MCP_AUTH_JWKS_URL=https://auth.example.com/.well-known/jwks.json
MCP_AUTH_ISSUER=https://auth.example.com/
MCP_AUTH_AUDIENCE=dynamic-mcp
MCP_AUTH_REQUIRED_SCOPES=mcp:tools
```

### Verification Flow

1. Extract `Bearer` token from `Authorization` header
2. Verify JWT signature against JWKS endpoint
3. Validate `iss` (issuer) and `aud` (audience) claims
4. Extract scopes from `scope` (space-separated string) or `scp` (array) claims
5. Ensure all required scopes are present
6. Extract client ID from `client_id`, `azp`, or `sub` claims

### Error Responses

| Status | Code | Condition |
|--------|------|-----------|
| 401 | -32001 | Missing or empty bearer token on MCP endpoint |
| 403 | -32002 | Invalid token, wrong issuer/audience, or missing scopes on MCP endpoint |

For production, protect `/livez`, `/readyz`, and `/metrics` at the network edge (Ingress/API gateway, mTLS, allowlists, private networking, or equivalent controls).

## Execution Guard

The `ToolExecutionGuard` enforces global concurrency and per-scope rate limits.

### Concurrency Limit

Maximum number of simultaneous tool executions across all scopes (default: 8). When exceeded, requests are rejected immediately.

### Rate Limit

Maximum number of calls per scope within a sliding time window (default: 300 calls per 60 seconds). Each tool and management operation has its own scope:

- `dynamic.tool.create`, `dynamic.tool.update`, etc. — management scopes
- `dynamic.exec.<tool-name>` — per-tool execution scopes
- `run_js_ephemeral` — ephemeral execution scope
- `sandbox.initialize`, `sandbox.exec`, etc. — sandbox session scopes

### Rejection Behavior

When limits are exceeded, the guard throws a `GuardRejectionError` and the call is rejected with an error result. The rejection is tracked in per-scope metrics and audit logged.

## HTTP Hardening

### Security Headers

All HTTP responses include:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevent MIME type sniffing |
| `X-Frame-Options` | `DENY` | Prevent clickjacking |
| `Referrer-Policy` | `no-referrer` | No referrer leakage |

### Request Size Limit

POST and DELETE requests with `Content-Length` exceeding `MCP_HTTP_MAX_REQUEST_BYTES` (default: 100 KB) are rejected with HTTP 413 before processing.

### Request Tracing

Every HTTP request receives an `x-request-id` header. If the client provides one, it is propagated; otherwise, a UUID is generated. This ID appears in error responses and audit logs.

### Session Expiry

Idle HTTP sessions are automatically expired after `MCP_HTTP_SESSION_TTL_SECONDS` (default: 30 minutes). A background sweep timer periodically checks for stale sessions and closes them.

## Audit Logging

Structured JSONL audit logging captures:

| Event | Logged |
|-------|--------|
| Tool create/update/delete/enable | Yes |
| Tool execution (ephemeral) | Yes |
| Sandbox session operations | Yes |
| Guard rejections | Yes |
| HTTP authentication success/denied | Yes |

### Sensitive Field Redaction

Audit event details are recursively scanned for sensitive keys. Fields matching the following pattern are replaced with `[REDACTED]`:

```
token, password, secret, authorization, cookie, api_key, apikey, api-key, bearer, credential
```

### Log Rotation

Logs are rotated when the file exceeds `MCP_AUDIT_MAX_FILE_BYTES` (default: 10 MB). Up to `MCP_AUDIT_MAX_FILES` (default: 5) rotated files are kept. Oversized events are truncated.

### Flush Guarantees

The audit logger uses an async write chain. On graceful shutdown, `flush()` is called to ensure all pending writes complete before the process exits.

## Sandbox Session Security (Enterprise)

Long-lived sandbox sessions share the same Docker security profile as ephemeral tools:

- Read-only root filesystem
- Writable `/tmp` (noexec) and `/workspace` (exec)
- Dropped capabilities, no new privileges
- PID, memory, and CPU limits
- Unprivileged `node` user

Additional session-specific protections:

- **Session ID validation:** Container IDs are sanitized against injection patterns
- **Shell command sanitization:** Commands are validated by policy before execution
- **Docker image sanitization:** Image names are validated before use
- **Idle scavenging:** Sessions idle beyond `MCP_SANDBOX_SESSION_TIMEOUT_SECONDS` are automatically stopped
- **Max sessions limit:** `MCP_SANDBOX_MAX_SESSIONS` prevents resource exhaustion
- **Cleanup hooks:** All sessions are stopped on `SIGINT`, `SIGTERM`, and `beforeExit`

## Kubernetes Hardening

The provided Kubernetes manifests include:

- **Non-root pod execution** (`runAsNonRoot`, `runAsUser: 10001`)
- **Read-only root filesystem** for the MCP pod
- **Dropped capabilities** in the container security context
- **No privilege escalation** (`allowPrivilegeEscalation: false`)
- **Resource requests and limits** for CPU and memory
- **Network policy** restricting ingress to pods labeled `mcp-client=true` and egress to PostgreSQL only
- **Pod Disruption Budget** ensuring at least 1 pod available during maintenance
