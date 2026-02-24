# Production Runbook

This runbook defines the minimum operational procedure for deploying `dynamic-mcp` in production.

## Target Baseline

Use this baseline unless you have an approved exception:

- Transport: `http`
- Profile: `enterprise`
- Registry backend: `postgres`
- Auth mode: `jwt`
- Audit logging: enabled

Start from [`.env.prod.example`](../.env.prod.example).

## 1. Pre-Deployment Checklist

1. Confirm image tag and git SHA for this release.
2. Confirm PostgreSQL connectivity and credentials.
3. Confirm JWT settings are valid: `MCP_AUTH_JWKS_URL`, `MCP_AUTH_ISSUER`, `MCP_AUTH_AUDIENCE`.
4. Confirm required scopes are configured (`MCP_AUTH_REQUIRED_SCOPES`) and match client tokens.
5. Confirm `MCP_REQUIRE_ADMIN_TOKEN=true` and `MCP_ADMIN_TOKEN` is configured in your secret manager.
6. Confirm Docker daemon strategy for dynamic execution (`DOCKER_HOST` and TLS if remote daemon is used).
7. Confirm `/livez`, `/readyz`, `/metrics` are restricted at network edge (private network, ingress policy, or gateway ACL).
8. Confirm audit log path capacity and retention (`MCP_AUDIT_FILE`, rotation settings).
9. Confirm rollback artifact for previous stable image is available.

## 2. Deployment Procedure

### Docker Compose

```bash
docker compose -f deploy/docker-compose.postgres.yml up -d --build
```

### Kubernetes

```bash
kubectl apply -f deploy/k8s/dynamic-mcp-postgres.yaml
kubectl apply -f deploy/k8s/dynamic-mcp-scalability.yaml
kubectl apply -f deploy/k8s/dynamic-mcp-networkpolicy.yaml
```

## 3. Post-Deployment Verification

Run these checks from an allowed network location.

### Health and Metrics

```bash
curl -fsS http://<HOST>:8788/livez
curl -fsS http://<HOST>:8788/readyz
curl -fsS http://<HOST>:8788/metrics | head
```

### JWT Boundary Validation

`/mcp` must reject unauthenticated requests:

```bash
curl -sS -o /tmp/mcp-no-token.json -w "%{http_code}\n" \
  -X POST http://<HOST>:8788/mcp \
  -H 'content-type: application/json' \
  --data '{}'
```

Expected status: `401`.

`/mcp` must accept a valid bearer token and not return `401`/`403`:

```bash
curl -sS -o /tmp/mcp-with-token.json -w "%{http_code}\n" \
  -X POST http://<HOST>:8788/mcp \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H 'content-type: application/json' \
  --data '{}'
```

Expected status: not `401`, not `403`.

## 4. Rollback Procedure

1. Redeploy previous stable image tag.
2. Re-run the post-deployment verification checklist.
3. Confirm error rates and latency recover to baseline.
4. Keep failed release logs and audit files for incident analysis.

## 5. Incident Triage

1. Check readiness first (`/readyz`) to identify backend dependency failures.
2. Check auth failures in metrics (`dynamic_mcp_http_auth_denied_total`) and audit logs (`http.auth`).
3. Check execution pressure via guard metrics (`system.guard_metrics` or `dynamic://metrics/guard`).
4. If dynamic tool execution fails, verify Docker daemon connectivity from the `dynamic-mcp` runtime.

## 6. Release Record (Per Deployment)

Record these fields in your change management system:

- Release timestamp (UTC)
- Service version / image tag / git SHA
- Operator and approver
- Scope changes (config/code)
- Verification result summary
- Rollback decision (not needed / executed)
