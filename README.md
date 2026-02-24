# dynamic-mcp

![Node CI](https://github.com/mcpland/dynamic-mcp/workflows/Node%20CI/badge.svg)
[![npm](https://img.shields.io/npm/v/dynamic-mcp.svg)](https://www.npmjs.com/package/dynamic-mcp)
![license](https://img.shields.io/npm/l/dynamic-mcp)

A production-grade **dynamic MCP server** for Node.js that enables runtime tool creation, management, and execution in isolated Docker sandboxes.

Unlike static MCP servers that define tools at compile time, dynamic-mcp lets AI agents and operators create, update, and delete tools on the fly — each running in a hardened Docker container with full lifecycle management.

## Key Features

- **Runtime tool management** — Create, update, delete, enable/disable tools without restarts via the `dynamic.tool.*` control plane
- **Docker sandbox isolation** — Every tool execution runs in a locked-down container (read-only FS, dropped capabilities, PID/memory/CPU limits)
- **Dual transport** — Stdio for local/CLI use, Streamable HTTP for networked deployments with per-session MCP servers
- **Dual registry backend** — File-based (single node) or PostgreSQL (multi-instance) with optimistic concurrency control
- **Execution guard** — Global concurrency and per-scope rate limiting to prevent abuse
- **JWT authentication** — Optional JWKS-based token verification for HTTP mode
- **Audit logging** — Structured JSONL logs with rotation, redaction of sensitive fields, and shutdown flush
- **Two profiles** — `mvp` (default) for core functionality, `enterprise` for long-lived sandbox sessions, metrics, and ops tools
- **Production-ready** — Health probes, Prometheus metrics, graceful shutdown, Kubernetes manifests, Docker Compose baselines

## Quick Start

**Prerequisites:** Node.js >= 20, pnpm, Docker

```bash
# Install dependencies
pnpm install

# Run in stdio mode (default, mvp profile)
pnpm run dev

# Run in HTTP mode
pnpm run dev:http

# Run with enterprise profile
pnpm run dev:enterprise
```

HTTP mode default endpoint: `http://127.0.0.1:8788/mcp`

## Recommended Operating Modes

- Development / PoC: `mvp` profile + `stdio` transport + file backend (`.env.example`)
- Production: `enterprise` profile + `http` transport + JWT auth + PostgreSQL backend (`.env.prod.example`)

## MCP Server Configuration

This project supports both MCP standard transports:

- `stdio` (recommended for local development/CLI clients)
- Streamable HTTP (recommended for remote/network deployment)

### 1. Prepare Runtime for Client Config

Most MCP clients launch your server as a child process in `stdio` mode, so build once before wiring client config:

```bash
pnpm install
pnpm build
```

Use an absolute path to `dist/index.js` in client config. Example:

```bash
node /ABS/PATH/TO/dynamic-mcp/dist/index.js --transport stdio --profile mvp
```

Dynamic code execution features (registered dynamic tools, `run_js_ephemeral`, `sandbox.*`) require a reachable Docker daemon.

### 2. Claude Desktop (Local stdio)

Claude Desktop uses a local `claude_desktop_config.json` file with `mcpServers`.

macOS path:
`~/Library/Application Support/Claude/claude_desktop_config.json`

Windows path:
`%APPDATA%\Claude\claude_desktop_config.json`

Example:

```json
{
  "mcpServers": {
    "dynamic-mcp": {
      "command": "node",
      "args": [
        "/ABS/PATH/TO/dynamic-mcp/dist/index.js",
        "--transport",
        "stdio",
        "--profile",
        "mvp"
      ],
      "env": {
        "MCP_DYNAMIC_BACKEND": "file",
        "MCP_DYNAMIC_STORE": "/ABS/PATH/TO/dynamic-mcp/.dynamic-mcp/tools.json",
        "MCP_SANDBOX_DOCKER_BIN": "docker"
      }
    }
  }
}
```

Note: Claude Desktop remote MCP server management is done in app settings (`Settings -> Connectors`), not in `claude_desktop_config.json`.

### 3. Claude Code

Add local stdio server:

```bash
claude mcp add dynamic-mcp -- node /ABS/PATH/TO/dynamic-mcp/dist/index.js --transport stdio --profile mvp
```

Add remote HTTP server:

```bash
claude mcp add --transport http dynamic-mcp-http http://127.0.0.1:8788/mcp
```

Project-level `.mcp.json` example (supports both local and remote server definitions):

```json
{
  "mcpServers": {
    "dynamic-mcp-local": {
      "command": "node",
      "args": [
        "/ABS/PATH/TO/dynamic-mcp/dist/index.js",
        "--transport",
        "stdio",
        "--profile",
        "enterprise"
      ]
    },
    "dynamic-mcp-http": {
      "type": "http",
      "url": "http://127.0.0.1:8788/mcp",
      "authorization_token": "${DYNAMIC_MCP_JWT_TOKEN}"
    }
  }
}
```

Claude Code supports environment variable expansion in config values, including `${VAR}` and `${VAR:-default}`.

### 4. VS Code

Use workspace config file: `.vscode/mcp.json`.

Local stdio example:

```json
{
  "servers": {
    "dynamic-mcp": {
      "command": "node",
      "args": [
        "/ABS/PATH/TO/dynamic-mcp/dist/index.js",
        "--transport",
        "stdio",
        "--profile",
        "mvp"
      ],
      "env": {
        "MCP_DYNAMIC_BACKEND": "file",
        "MCP_SANDBOX_DOCKER_BIN": "docker"
      }
    }
  }
}
```

Remote HTTP + JWT header example:

```json
{
  "servers": {
    "dynamic-mcp-http": {
      "url": "http://127.0.0.1:8788/mcp",
      "headers": {
        "Authorization": "Bearer ${input:dynamic_mcp_jwt}"
      }
    }
  },
  "inputs": [
    {
      "type": "promptString",
      "id": "dynamic_mcp_jwt",
      "description": "JWT Bearer token for dynamic-mcp"
    }
  ]
}
```

### 5. HTTP Mode Details for This Repo

Server startup example:

```bash
pnpm run dev:http
# or:
node /ABS/PATH/TO/dynamic-mcp/dist/index.js --transport http --host 127.0.0.1 --port 8788 --path /mcp
```

In HTTP mode, the server runs as an independent process/container, and MCP clients connect to the configured URL.

HTTP endpoints:

- `POST /mcp` initialize/continue MCP session
- `GET /mcp` session stream
- `DELETE /mcp` close session
- `GET /livez` liveness
- `GET /readyz` readiness
- `GET /metrics` Prometheus metrics

JWT behavior in this repo:

- When `MCP_AUTH_MODE=jwt`, authentication is enforced on MCP endpoint requests (`${MCP_PATH}`, default `/mcp`).
- `/livez`, `/readyz`, `/metrics` remain anonymous by default.

Production recommendation: keep `/livez`, `/readyz`, `/metrics` behind private networking, ingress allowlists, or a gateway even when JWT is enabled.

### 6. Minimal Secure Baseline (Recommended)

```bash
MCP_TRANSPORT=http
MCP_PROFILE=enterprise
MCP_HOST=0.0.0.0
MCP_PORT=8788
MCP_PATH=/mcp
MCP_DYNAMIC_BACKEND=postgres
MCP_REQUIRE_ADMIN_TOKEN=true
MCP_ADMIN_TOKEN=change-me
MCP_AUTH_MODE=jwt
MCP_AUTH_JWKS_URL=https://your-idp.example.com/.well-known/jwks.json
MCP_AUTH_ISSUER=https://your-idp.example.com/
MCP_AUTH_AUDIENCE=dynamic-mcp
MCP_AUTH_REQUIRED_SCOPES=mcp.invoke
```

Full variable reference: [docs/configuration.md](docs/configuration.md)

Production baseline assets:

- [`.env.prod.example`](.env.prod.example)
- [`docs/production-runbook.md`](docs/production-runbook.md)

## Documentation

| Document                                         | Description                                           |
| ------------------------------------------------ | ----------------------------------------------------- |
| [Architecture](docs/architecture.md)             | System design, module structure, and data flow        |
| [Configuration](docs/configuration.md)           | All environment variables and CLI arguments           |
| [API Reference](docs/api-reference.md)           | Complete tool, resource, and prompt reference         |
| [Dynamic Tools Guide](docs/dynamic-tools.md)     | How to author and manage dynamic tools                |
| [Security](docs/security.md)                     | Security model, sandbox isolation, and authentication |
| [Deployment](docs/deployment.md)                 | Docker, Compose, and Kubernetes deployment guides     |
| [Production Runbook](docs/production-runbook.md) | Production rollout, verification, and rollback steps  |

## Profiles

### MVP (default)

Core dynamic tool engine:

| Tool                  | Description                               |
| --------------------- | ----------------------------------------- |
| `dynamic.tool.create` | Register a new dynamic tool               |
| `dynamic.tool.update` | Modify an existing tool definition        |
| `dynamic.tool.delete` | Remove a tool                             |
| `dynamic.tool.list`   | List all registered tools                 |
| `dynamic.tool.get`    | Get a single tool definition              |
| `dynamic.tool.enable` | Enable or disable a tool                  |
| `run_js_ephemeral`    | One-off JavaScript execution in a sandbox |
| `system.health`       | Server liveness and uptime                |

### Enterprise

Everything in MVP, plus:

| Tool / Resource                    | Description                         |
| ---------------------------------- | ----------------------------------- |
| `sandbox.initialize`               | Create a reusable container session |
| `sandbox.exec`                     | Run shell commands in a session     |
| `sandbox.run_js`                   | Run JavaScript in a session         |
| `sandbox.stop`                     | Stop a session container            |
| `sandbox.session.list`             | List active sessions                |
| `system.guard_metrics`             | Concurrency/rate-limit counters     |
| `system.runtime_config`            | Sanitized config snapshot           |
| `dynamic://metrics/guard`          | Guard metrics resource              |
| `dynamic://service/runtime-config` | Config snapshot resource            |
| `dynamic://service/meta`           | Service metadata resource           |
| `tool-call-checklist`              | Reusable pre-call checklist prompt  |

## Example: Creating a Dynamic Tool

```json
{
  "tool": {
    "name": "text.uppercase",
    "description": "Convert text to uppercase",
    "code": "const { text } = args;\nreturn { upper: String(text).toUpperCase() };",
    "dependencies": [],
    "image": "node:lts-slim",
    "timeoutMs": 10000
  }
}
```

Then invoke it:

```json
{
  "args": { "text": "hello world" }
}
```

See the [Dynamic Tools Guide](docs/dynamic-tools.md) for full details.

## Docker

```bash
docker build -t dynamic-mcp:latest .
docker run --rm -p 8788:8788 dynamic-mcp:latest
```

For dynamic tool execution (registered dynamic tools, `run_js_ephemeral`, `sandbox.*`) in containerized deployments, the running `dynamic-mcp` process must have:

- A Docker CLI binary available in the container (`docker`)
- Connectivity and authorization to a Docker daemon (local socket or remote daemon)

Without that access, dynamic tool execution will fail at runtime.

Security note: exposing the host Docker socket gives the container high privilege over the host. Prefer a dedicated remote Docker daemon with network isolation and TLS for production.

## Docker Compose (with PostgreSQL)

```bash
docker compose -f deploy/docker-compose.postgres.yml up -d --build
```

## Kubernetes

```bash
kubectl apply -f deploy/k8s/dynamic-mcp-postgres.yaml
# Optional: HPA + PDB
kubectl apply -f deploy/k8s/dynamic-mcp-scalability.yaml
# Optional: Network policy
kubectl apply -f deploy/k8s/dynamic-mcp-networkpolicy.yaml
```

## Development

```bash
pnpm run dev          # stdio mode, mvp profile
pnpm run dev:mvp      # explicit mvp profile
pnpm run dev:http     # HTTP mode
pnpm run dev:enterprise  # enterprise profile
pnpm run test         # run tests
pnpm run lint         # lint
pnpm run typecheck    # type check
pnpm run build        # compile TypeScript
```

## License

MIT
