# Deployment

## Prerequisites

- **Node.js** >= 20
- **Docker** (required for tool execution)
- **pnpm** (for building from source)

## Recommended Baseline

- Local development and PoC: use [`.env.example`](../.env.example)
- Production baseline: use [`.env.prod.example`](../.env.prod.example)
- Rollout and rollback procedure: follow [`docs/production-runbook.md`](production-runbook.md)

## Local Development

```bash
# Install dependencies
pnpm install

# Stdio mode (default)
pnpm run dev

# HTTP mode
pnpm run dev:http

# Enterprise profile
pnpm run dev:enterprise

# Explicit CLI args
pnpm run dev -- --transport http --host 0.0.0.0 --port 9000 --profile enterprise
```

## Docker

### Build

```bash
docker build -t dynamic-mcp:latest .
```

The Dockerfile uses a multi-stage build:

1. **deps** — Install dependencies with pnpm
2. **build** — Compile TypeScript and prune dev dependencies
3. **runtime** — Minimal `node:22-alpine` image with production artifacts

### Run

```bash
# HTTP mode (default in Docker)
docker run --rm -p 8788:8788 dynamic-mcp:latest

# With environment overrides
docker run --rm -p 8788:8788 \
  -e MCP_PROFILE=enterprise \
  -e MCP_ADMIN_TOKEN=my-secret \
  -e MCP_AUDIT_ENABLED=true \
  dynamic-mcp:latest

# With persistent audit logs
docker run --rm -p 8788:8788 \
  -v mcp-data:/data \
  -e MCP_AUDIT_FILE=/data/audit.log \
  dynamic-mcp:latest
```

### Dynamic Execution Requirements (Containers)

To execute dynamic tools in Docker/Kubernetes, the `dynamic-mcp` process needs both:

1. A Docker CLI binary inside the runtime container (`docker`)
2. Reachable Docker daemon credentials (local socket or remote daemon)

If either is missing, calls to registered dynamic tools, `run_js_ephemeral`, and `sandbox.*` fail with Docker availability errors.

Common production approach:

- Use a dedicated remote Docker daemon
- Set Docker client environment (`DOCKER_HOST`, and TLS settings if enabled) on the `dynamic-mcp` container
- Keep network policy scoped to only that daemon endpoint

Security boundary:

- Mounting `/var/run/docker.sock` into the app container is effectively host-level privilege
- Treat this as a high-trust deployment mode and restrict who can call management/execution tools

### Health Checks

```bash
# Liveness
curl http://127.0.0.1:8788/livez
# {"status":"ok"}

# Readiness (checks backend connectivity)
curl http://127.0.0.1:8788/readyz
# {"status":"ready"}

# Metrics
curl http://127.0.0.1:8788/metrics
```

## Docker Compose (with PostgreSQL)

The `deploy/docker-compose.postgres.yml` file provides a complete stack with PostgreSQL for the tool registry.

### Start

```bash
docker compose -f deploy/docker-compose.postgres.yml up -d --build
```

### Stack Components

| Service | Image | Purpose |
|---------|-------|---------|
| `postgres` | `postgres:17-alpine` | Tool registry storage |
| `dynamic-mcp` | Built from Dockerfile | MCP server |

### Configuration

The Compose file includes sensible defaults:

- PostgreSQL database: `dynamic_mcp`
- PostgreSQL user: `dynamic_mcp`
- MCP backend: `postgres`
- Audit logging: enabled at `/data/audit.log`
- Health checks for both services

Important: the sample Compose stack does not provide Docker daemon access to the `dynamic-mcp` container. Add a daemon access strategy (host socket or remote daemon) if you need dynamic execution inside the container.

### Customization

Update the `environment` section in the Compose file to change settings. Key values to customize for production:

```yaml
environment:
  # Change the PostgreSQL password
  MCP_DYNAMIC_PG_URL: postgres://dynamic_mcp:STRONG_PASSWORD@postgres:5432/dynamic_mcp

  # Add admin token
  MCP_ADMIN_TOKEN: your-secret-admin-token

  # Enable JWT auth
  MCP_AUTH_MODE: jwt
  MCP_AUTH_JWKS_URL: https://auth.example.com/.well-known/jwks.json
  MCP_AUTH_ISSUER: https://auth.example.com/
  MCP_AUTH_AUDIENCE: dynamic-mcp
```

### Stop

```bash
docker compose -f deploy/docker-compose.postgres.yml down -v --remove-orphans
```

## Kubernetes

### Base Deployment

The `deploy/k8s/dynamic-mcp-postgres.yaml` manifest includes:

- **ConfigMap** — Non-secret environment variables
- **Secret** — PostgreSQL connection string
- **Deployment** — 2 replicas with security context, resource limits, and health probes
- **Service** — ClusterIP service on port 8788 with Prometheus scrape annotations

Important: the sample Kubernetes manifest does not configure Docker daemon access for `dynamic-mcp`. For dynamic execution in-cluster, wire the pod to a dedicated remote daemon (recommended) or another controlled runtime integration.

#### Deploy

```bash
kubectl apply -f deploy/k8s/dynamic-mcp-postgres.yaml
```

#### Pre-deployment Checklist

1. Update the `image` field in the Deployment to your container registry
2. Update the `MCP_DYNAMIC_PG_URL` secret with your PostgreSQL connection string
3. Configure an external PostgreSQL instance (the manifest does not include one)
4. Review resource requests/limits for your workload

### Scalability (HPA + PDB)

The `deploy/k8s/dynamic-mcp-scalability.yaml` manifest provides:

- **HorizontalPodAutoscaler** — Scales from 2 to 10 replicas based on CPU utilization (65% target)
- **PodDisruptionBudget** — At least 1 pod available during voluntary disruptions

```bash
kubectl apply -f deploy/k8s/dynamic-mcp-scalability.yaml
```

### Network Policy

The `deploy/k8s/dynamic-mcp-networkpolicy.yaml` restricts traffic:

**Ingress:** Only pods labeled `mcp-client=true` can reach port 8788.

**Egress:** Only PostgreSQL (port 5432) and DNS (port 53) are allowed.

```bash
kubectl apply -f deploy/k8s/dynamic-mcp-networkpolicy.yaml
```

To grant a client pod access:

```yaml
metadata:
  labels:
    mcp-client: "true"
```

### Security Context

The Kubernetes Deployment enforces:

| Setting | Value |
|---------|-------|
| `runAsNonRoot` | `true` |
| `runAsUser` | `10001` |
| `runAsGroup` | `10001` |
| `readOnlyRootFilesystem` | `true` |
| `allowPrivilegeEscalation` | `false` |
| `capabilities.drop` | `ALL` |

### Health Probes

| Probe | Endpoint | Initial Delay | Period | Timeout | Failures |
|-------|----------|---------------|--------|---------|----------|
| Liveness | `/livez` | 10s | 10s | 2s | 3 |
| Readiness | `/readyz` | 5s | 5s | 2s | 6 |

### Prometheus Integration

The Service includes scrape annotations:

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/path: "/metrics"
  prometheus.io/port: "8788"
```

## CI/CD

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs:

| Job | Description |
|-----|-------------|
| `verify` | Lint, test, and build on Node.js 20 and 22 |
| `docker-http-smoke` | Build Docker image and verify `/livez` + `/readyz` |
| `docker-http-jwt-smoke` | Verify `/mcp` JWT enforcement and anonymous `/livez` `/readyz` `/metrics` behavior |
| `compose-postgres-smoke` | Start the full Compose stack and verify readiness |
| `k8s-manifest-validate` | Dry-run kubectl apply on all Kubernetes manifests |

## Production Considerations

### Multi-Instance Setup

For multi-instance deployments, use the PostgreSQL backend:

```env
MCP_DYNAMIC_BACKEND=postgres
MCP_DYNAMIC_PG_URL=postgres://user:pass@host:5432/db
```

All instances share the same tool registry with optimistic concurrency control.

### Monitoring

- **Health probes:** `/livez` and `/readyz` for load balancers and orchestrators
- **Prometheus metrics:** `GET /metrics` for dashboarding and alerting
- **Audit logs:** Structured JSONL at `MCP_AUDIT_FILE` for compliance and debugging
- **Guard metrics:** `system.guard_metrics` tool or `dynamic://metrics/guard` resource for real-time execution stats

### Resource Tuning

Key parameters to tune for production:

| Parameter | Consideration |
|-----------|--------------|
| `MCP_TOOL_MAX_CONCURRENCY` | Match to available CPU/memory for Docker containers |
| `MCP_TOOL_MAX_CALLS_PER_WINDOW` | Adjust based on expected throughput |
| `MCP_SANDBOX_MEMORY_LIMIT` | Per-container memory; total = concurrency x limit |
| `MCP_SANDBOX_CPU_LIMIT` | Per-container CPU; total = concurrency x limit |
| `MCP_HTTP_SESSION_TTL_SECONDS` | Balance between client convenience and resource usage |
| `MCP_DYNAMIC_MAX_TOOLS` | Set based on expected tool count |
