# dynamic-mcp

A production-oriented **dynamic MCP server** in Node.js, with secure Docker sandbox execution and runtime tool management.

Default profile is `mvp` (`MCP_PROFILE=mvp`), focused on dynamic Node.js tool execution.

## Core capabilities

- Dynamic tool control plane (`dynamic.tool.*`):
  - `dynamic.tool.create`
  - `dynamic.tool.update`
  - `dynamic.tool.delete`
  - `dynamic.tool.list`
  - `dynamic.tool.get`
  - `dynamic.tool.enable`
- Dynamic tool runtime execution in isolated Docker containers.
- Global execution guard (concurrency + rate limit).

## Enterprise profile extras

Set `MCP_PROFILE=enterprise` to enable additional platform/ops features:

- Reusable sandbox sessions:
  - `sandbox.initialize`
  - `sandbox.exec`
  - `sandbox.run_js`
  - `sandbox.stop`
  - `sandbox.session.list`
- Guard metrics resource/tool:
  - resource: `dynamic://metrics/guard`
  - tool: `system.guard_metrics`
- Runtime config snapshot:
  - resource: `dynamic://service/runtime-config`
  - tool: `system.runtime_config`

## Security model

- Docker isolation for code execution.
- Restricted container profile:
  - `--read-only`
  - `--cap-drop ALL`
  - `--security-opt no-new-privileges`
  - `--pids-limit`
  - CPU/memory limits
- Optional admin token (`MCP_ADMIN_TOKEN`) for dangerous operations.
- Allowlist/denylist controls for images and npm packages.
- Runtime guard for anti-abuse throttling.
- Hardened HTTP response headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`).
- HTTP request body size limit (`MCP_HTTP_MAX_REQUEST_BYTES`) for DoS resistance.
- Optional JWT auth in HTTP mode (JWKS/issuer/audience/scope).
- Structured JSONL audit logging for privileged/runtime actions.
- Structured JSONL audit logging with shutdown flush guarantees.
- Structured JSONL audit logging with sensitive field redaction.
- Optimistic concurrency control for dynamic tool writes (`expectedRevision`).
- Graceful shared Postgres pool shutdown on HTTP transport stop.
- Graceful shutdown hooks for both HTTP and stdio transports.

## Quick start

```bash
npm install
npm run dev:mvp
```

HTTP mode:

```bash
npm run dev:http
```

Enterprise profile:

```bash
npm run dev:enterprise
```

Default endpoint: `http://127.0.0.1:8788/mcp`

Health probes:

- `GET /livez` -> process liveness
- `GET /readyz` -> backend readiness (checks dynamic registry backend dependencies)
- `GET /metrics` -> Prometheus-style runtime metrics
- All HTTP responses include `x-request-id` (propagated from request header if provided).
- HTTP MCP sessions are auto-expired by `MCP_HTTP_SESSION_TTL_SECONDS`.

## Environment variables

See `.env.example`.

Key vars:

- `MCP_PROFILE` (`mvp` or `enterprise`)
- `MCP_TRANSPORT`
- `MCP_HTTP_SESSION_TTL_SECONDS`
- `MCP_HTTP_MAX_REQUEST_BYTES`
- `MCP_DYNAMIC_STORE`
- `MCP_DYNAMIC_BACKEND` (`file` or `postgres`)
- `MCP_DYNAMIC_PG_URL`
- `MCP_DYNAMIC_PG_SCHEMA`
- `MCP_DYNAMIC_PG_INIT_MAX_ATTEMPTS`
- `MCP_DYNAMIC_PG_INIT_BACKOFF_MS`
- `MCP_DYNAMIC_MAX_TOOLS`
- `MCP_DYNAMIC_READ_ONLY`
- `MCP_ADMIN_TOKEN`
- `MCP_SANDBOX_ALLOWED_IMAGES`
- `MCP_SANDBOX_BLOCKED_PACKAGES`
- `MCP_SANDBOX_MEMORY_LIMIT`
- `MCP_SANDBOX_CPU_LIMIT`
- `MCP_TOOL_MAX_CONCURRENCY`
- `MCP_TOOL_MAX_CALLS_PER_WINDOW`
- `MCP_TOOL_RATE_WINDOW_MS`
- `MCP_AUTH_MODE`
- `MCP_AUTH_JWKS_URL`
- `MCP_AUTH_ISSUER`
- `MCP_AUTH_AUDIENCE`
- `MCP_AUTH_REQUIRED_SCOPES`
- `MCP_AUDIT_ENABLED`
- `MCP_AUDIT_FILE`
- `MCP_AUDIT_MAX_EVENT_BYTES`
- `MCP_AUDIT_MAX_FILE_BYTES`
- `MCP_AUDIT_MAX_FILES`

## Dynamic tool code contract

`dynamic.tool.create` stores `code` as an async function body. At execution time it runs inside:

```js
export async function run(args) {
  // your code body
}
```

Inside code, return any JSON-serializable value.

Example code body:

```js
const { text } = args;
return { upper: String(text).toUpperCase() };
```

Then invoke the tool with:

```json
{
  "args": { "text": "hello" }
}
```

## Dynamic writes with revision safety

Write operations (`dynamic.tool.update`, `dynamic.tool.enable`, `dynamic.tool.delete`) support
optional `expectedRevision`.

When provided, the server rejects stale writes with a revision conflict error instead of
silently overwriting newer updates.

## Scripts

- `npm run dev`
- `npm run dev:mvp`
- `npm run dev:enterprise`
- `npm run dev:stdio`
- `npm run dev:http`
- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run typecheck`

## CI and Docker

- CI: `.github/workflows/ci.yml`
- Dockerfile: `Dockerfile`

CI now includes:

- Node verify matrix (`lint`, `test`, `build`)
- HTTP Docker image smoke (`/livez`, `/readyz`)
- Postgres compose smoke (`deploy/docker-compose.postgres.yml`)
- Compose spec validation (`docker compose config -q`)
- Kubernetes manifest dry-run validation (`kubectl --dry-run=client`)

Run container:

```bash
docker build -t dynamic-mcp:latest .
docker run --rm -p 8788:8788 dynamic-mcp:latest
```

## Deployment Baselines

Postgres-backed compose baseline:

```bash
docker compose -f deploy/docker-compose.postgres.yml up -d --build
```

Kubernetes baseline manifest:

```bash
kubectl apply -f deploy/k8s/dynamic-mcp-postgres.yaml
```

Optional scalability policies (HPA + PDB):

```bash
kubectl apply -f deploy/k8s/dynamic-mcp-scalability.yaml
```

Optional network hardening policy:

```bash
kubectl apply -f deploy/k8s/dynamic-mcp-networkpolicy.yaml
```

After applying, only pods labeled `mcp-client=true` can call port `8788` on `dynamic-mcp`.

Before applying k8s manifests, update:

- `image` in `deploy/k8s/dynamic-mcp-postgres.yaml`
- `MCP_DYNAMIC_PG_URL` secret value
