# Configuration

dynamic-mcp supports configuration via environment variables, CLI arguments, and a `.env` file. CLI arguments take precedence over environment variables, which take precedence over `.env` defaults.

CLI argument format: `--key=value` or `--key value`

## Baseline Templates

- Development/PoC baseline: [`.env.example`](../.env.example) (`mvp` + `stdio`)
- Production baseline: [`.env.prod.example`](../.env.prod.example) (`enterprise` + `http` + `jwt` + `postgres`)

For deployment workflow, acceptance checks, and rollback procedure, see [`docs/production-runbook.md`](production-runbook.md).

## General

| Env Variable | CLI Arg | Default | Description |
|-------------|---------|---------|-------------|
| `MCP_PROFILE` | `--profile` | `mvp` | Feature profile: `mvp` or `enterprise` |
| `MCP_TRANSPORT` | `--transport` | `stdio` | Transport mode: `stdio` or `http` |

## HTTP Transport

Used when `MCP_TRANSPORT=http`.

| Env Variable | CLI Arg | Default | Description |
|-------------|---------|---------|-------------|
| `MCP_HOST` | `--host` | `127.0.0.1` | HTTP bind address |
| `MCP_PORT` / `PORT` | `--port` | `8788` | HTTP listen port (1–65535) |
| `MCP_PATH` | `--path` | `/mcp` | MCP endpoint path |
| `MCP_HTTP_SESSION_TTL_SECONDS` | `--http-session-ttl-seconds` | `1800` | Session idle timeout in seconds (max 604800) |
| `MCP_HTTP_MAX_REQUEST_BYTES` | `--http-max-request-bytes` | `1000000` | Maximum request body size in bytes (max 100000000) |

### HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `${MCP_PATH}` (default: `/mcp`) | `POST` | Initialize or continue an MCP session |
| `${MCP_PATH}` (default: `/mcp`) | `GET` | SSE stream for a session |
| `${MCP_PATH}` (default: `/mcp`) | `DELETE` | Close an MCP session |
| `/livez` | `GET` | Process liveness check |
| `/readyz` | `GET` | Backend readiness check (Postgres connectivity) |
| `/metrics` | `GET` | Prometheus-format runtime metrics |

All HTTP responses include an `x-request-id` header (propagated from the request or auto-generated).

When `MCP_AUTH_MODE=jwt`, authentication is enforced on `${MCP_PATH}` requests. `/livez`, `/readyz`, and `/metrics` remain unauthenticated by default.

### Prometheus Metrics

Available at `GET /metrics`:

| Metric | Type | Description |
|--------|------|-------------|
| `dynamic_mcp_process_uptime_seconds` | gauge | Process uptime |
| `dynamic_mcp_http_sessions_active` | gauge | Current active sessions |
| `dynamic_mcp_http_sessions_created_total` | counter | Total sessions created |
| `dynamic_mcp_http_sessions_expired_total` | counter | Total sessions expired |
| `dynamic_mcp_http_auth_success_total` | counter | Successful authentications |
| `dynamic_mcp_http_auth_denied_total` | counter | Denied authentications |

## Dynamic Tool Registry

| Env Variable | CLI Arg | Default | Description |
|-------------|---------|---------|-------------|
| `MCP_DYNAMIC_BACKEND` | `--dynamic-backend` | `file` | Registry backend: `file` or `postgres` |
| `MCP_DYNAMIC_STORE` | `--dynamic-store` | `.dynamic-mcp/tools.json` | File path for the file-based registry |
| `MCP_DYNAMIC_MAX_TOOLS` | `--dynamic-max-tools` | `256` | Maximum number of stored tools (1–10000) |
| `MCP_DYNAMIC_READ_ONLY` | `--dynamic-read-only` | `false` | Disable tool creation/update/delete when `true` |
| `MCP_ADMIN_TOKEN` | `--admin-token` | *(none)* | Admin token required for privileged operations |

### PostgreSQL Backend

Required when `MCP_DYNAMIC_BACKEND=postgres`.

| Env Variable | CLI Arg | Default | Description |
|-------------|---------|---------|-------------|
| `MCP_DYNAMIC_PG_URL` | `--dynamic-pg-url` | *(required)* | PostgreSQL connection string |
| `MCP_DYNAMIC_PG_SCHEMA` | `--dynamic-pg-schema` | `dynamic_mcp` | Database schema name |
| `MCP_DYNAMIC_PG_INIT_MAX_ATTEMPTS` | `--dynamic-pg-init-max-attempts` | `10` | Max retries for schema/table initialization (max 100) |
| `MCP_DYNAMIC_PG_INIT_BACKOFF_MS` | `--dynamic-pg-init-backoff-ms` | `1000` | Base backoff between init retries in ms (max 60000) |

## Sandbox Execution

| Env Variable | CLI Arg | Default | Description |
|-------------|---------|---------|-------------|
| `MCP_SANDBOX_DOCKER_BIN` | `--docker-bin` | `docker` | Path to Docker binary |
| `MCP_SANDBOX_MEMORY_LIMIT` | `--sandbox-memory` | `512m` | Container memory limit |
| `MCP_SANDBOX_CPU_LIMIT` | `--sandbox-cpu` | `1` | Container CPU limit |
| `MCP_SANDBOX_MAX_DEPENDENCIES` | `--sandbox-max-dependencies` | `32` | Max npm dependencies per tool (max 256) |
| `MCP_SANDBOX_MAX_OUTPUT_BYTES` | `--sandbox-max-output-bytes` | `200000` | Max output size from tool execution (max 10000000) |
| `MCP_SANDBOX_MAX_TIMEOUT_MS` | `--sandbox-max-timeout-ms` | `120000` | Max tool execution timeout in ms (max 300000) |
| `MCP_SANDBOX_ALLOWED_IMAGES` | `--sandbox-allowed-images` | `node:lts-slim` | Comma-separated allowlist of Docker images |
| `MCP_SANDBOX_BLOCKED_PACKAGES` | `--sandbox-blocked-packages` | `child_process,node-pty,npm,pm2` | Comma-separated blocklist of npm packages |
| `MCP_SANDBOX_SESSION_TIMEOUT_SECONDS` | `--sandbox-session-timeout-seconds` | `1800` | Idle timeout for sandbox sessions (enterprise, max 172800) |
| `MCP_SANDBOX_MAX_SESSIONS` | `--sandbox-max-sessions` | `20` | Max concurrent sandbox sessions (enterprise, max 1000) |

## Execution Guard

Global concurrency and rate limiting for all tool executions.

| Env Variable | CLI Arg | Default | Description |
|-------------|---------|---------|-------------|
| `MCP_TOOL_MAX_CONCURRENCY` | `--tool-max-concurrency` | `8` | Max concurrent tool executions (max 10000) |
| `MCP_TOOL_MAX_CALLS_PER_WINDOW` | `--tool-max-calls-per-window` | `300` | Max calls per scope within the rate window (max 1000000) |
| `MCP_TOOL_RATE_WINDOW_MS` | `--tool-rate-window-ms` | `60000` | Rate limit sliding window in ms (max 86400000) |

## Authentication

| Env Variable | CLI Arg | Default | Description |
|-------------|---------|---------|-------------|
| `MCP_AUTH_MODE` | `--auth-mode` | `none` | Auth mode: `none` or `jwt` |
| `MCP_AUTH_JWKS_URL` | `--auth-jwks-url` | *(required if jwt)* | JWKS endpoint URL |
| `MCP_AUTH_ISSUER` | `--auth-issuer` | *(required if jwt)* | Expected JWT issuer |
| `MCP_AUTH_AUDIENCE` | `--auth-audience` | *(required if jwt)* | Expected JWT audience |
| `MCP_AUTH_REQUIRED_SCOPES` | `--auth-required-scopes` | *(empty)* | Comma-separated required scopes |

## Audit Logging

| Env Variable | CLI Arg | Default | Description |
|-------------|---------|---------|-------------|
| `MCP_AUDIT_ENABLED` | `--audit-enabled` | `false` (mvp) / `true` (enterprise) | Enable audit logging |
| `MCP_AUDIT_FILE` | `--audit-file` | `.dynamic-mcp/audit.log` | Audit log file path |
| `MCP_AUDIT_MAX_EVENT_BYTES` | `--audit-max-event-bytes` | `20000` | Max single event size; oversized events are truncated (max 1000000) |
| `MCP_AUDIT_MAX_FILE_BYTES` | `--audit-max-file-bytes` | `10000000` | Max log file size before rotation (max 1000000000) |
| `MCP_AUDIT_MAX_FILES` | `--audit-max-files` | `5` | Number of rotated log files to keep (max 100) |

## Example `.env`

See [`.env.example`](../.env.example) for local development defaults, and [`.env.prod.example`](../.env.prod.example) for a production-ready baseline template.
