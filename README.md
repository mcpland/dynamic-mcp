# dynamic-mcp

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

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System design, module structure, and data flow |
| [Configuration](docs/configuration.md) | All environment variables and CLI arguments |
| [API Reference](docs/api-reference.md) | Complete tool, resource, and prompt reference |
| [Dynamic Tools Guide](docs/dynamic-tools.md) | How to author and manage dynamic tools |
| [Security](docs/security.md) | Security model, sandbox isolation, and authentication |
| [Deployment](docs/deployment.md) | Docker, Compose, and Kubernetes deployment guides |

## Profiles

### MVP (default)

Core dynamic tool engine:

| Tool | Description |
|------|-------------|
| `dynamic.tool.create` | Register a new dynamic tool |
| `dynamic.tool.update` | Modify an existing tool definition |
| `dynamic.tool.delete` | Remove a tool |
| `dynamic.tool.list` | List all registered tools |
| `dynamic.tool.get` | Get a single tool definition |
| `dynamic.tool.enable` | Enable or disable a tool |
| `run_js_ephemeral` | One-off JavaScript execution in a sandbox |
| `system.health` | Server liveness and uptime |

### Enterprise

Everything in MVP, plus:

| Tool / Resource | Description |
|-----------------|-------------|
| `sandbox.initialize` | Create a reusable container session |
| `sandbox.exec` | Run shell commands in a session |
| `sandbox.run_js` | Run JavaScript in a session |
| `sandbox.stop` | Stop a session container |
| `sandbox.session.list` | List active sessions |
| `system.guard_metrics` | Concurrency/rate-limit counters |
| `system.runtime_config` | Sanitized config snapshot |
| `dynamic://metrics/guard` | Guard metrics resource |
| `dynamic://service/runtime-config` | Config snapshot resource |
| `dynamic://service/meta` | Service metadata resource |
| `tool-call-checklist` | Reusable pre-call checklist prompt |

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

For dynamic tool execution (`dynamic.exec.*`, `run_js_ephemeral`, `sandbox.*`) in containerized deployments, the running `dynamic-mcp` process must have:

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

See [LICENSE](LICENSE).
