# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server that exposes FHIR R4 operations as tools. It authenticates to PingOne with the OAuth 2.0 `client_credentials` grant (`client_secret_basic`). It runs over stdio, where an MCP host spawns the process, or over Streamable HTTP, which is how it runs in Kubernetes behind PingGateway.

## Commands

```bash
npm install
npm run typecheck   # tsc --noEmit (CI gate)
npm test            # node:test via ts-node, test/*.test.ts (CI gate)
npm test -- --test-name-pattern="401"   # run matching tests only
npm run build       # tsc -> dist/
npm start           # stdio, from dist/
npm run start:http  # Streamable HTTP on PORT (default 3000)
npm run dev         # stdio via ts-node
npm run dev:http    # HTTP via ts-node
```

There is no linter. CI (`.github/workflows/deploy-main.yml`) runs `typecheck`, `test` and `build` before it builds the image and deploys. Tests in `test/` start a local stub HTTP server as the FHIR base, stub `axios.post` for the PingOne token call, and `require()` `src/` only after setting the env vars, because `config.ts` reads them at import time. To check behavior by hand, run `npm run dev:http` and point `npx @modelcontextprotocol/inspector` at `http://localhost:3000/mcp`, or use the curl `initialize` smoke test in README.md.

Configuration comes from env vars, loaded from `.env` in the project root (copy `.env.example`). Variables already set in the environment take precedence over `.env`. `src/config.ts` throws at import time if `PINGONE_ENV_ID`, `PINGONE_CLIENT_ID`, `PINGONE_CLIENT_SECRET` or `FHIR_BASE_URL` is missing, so the server won't start without them. `typecheck` and `build` don't need them.

## Architecture

Request flow: `index.ts` → transport → `server.ts` (`createServer`) → `tools.ts` handler → `fhir-client.ts` → `auth.ts` for the bearer token.

- **`index.ts`**: picks the transport from `MCP_TRANSPORT` (`stdio` | `http`). In stdio mode, stdout is the protocol channel, so all logging must use `console.error`.
- **`server.ts`**: `createServer()` builds a new MCP `Server` on every call. A `Server` can connect to only one transport, and the HTTP transport is per-session. Don't hoist it into a module-level singleton. Tool input is validated with each tool's Zod schema. Handler errors come back as `isError` text content rather than thrown MCP errors.
- **Hand-rolled Zod → JSON Schema** (`buildJsonSchema` in `server.ts`): it handles only Object, Optional, Default, String, Number, Boolean, Array, Record, Enum, Union, Unknown and Any. Any other Zod type, such as `nullable`, `literal`, `.refine()`/effects or nested `describe` wrappers, falls through to `{ description }`, which leaves clients with an empty schema. Extend this function if a new tool needs one of those types.
- **`tools.ts`**: one flat `tools: ToolDefinition[]` array. Each entry is wrapped in `defineTool({...})`, which types the handler's `input` from the Zod `inputSchema`, so don't cast `input`. Handlers return a string (usually `JSON.stringify(..., null, 2)`). Add a tool by appending an entry here. No registration is needed elsewhere.
- **`fhir-client.ts`**: one shared axios instance against `FHIR_BASE_URL`, using `application/fhir+json` and `Prefer: return=representation`. `paramsSerializer: { indexes: null }` sends arrays as repeated keys (`date=a&date=b`), which FHIR requires. Build every URL path with `resourcePath()`/`operationSegment()`, which validate resource types, FHIR ids and operation names; never interpolate tool input into a path directly. On a 401 it clears the token cache and retries once. It turns FHIR `OperationOutcome` responses into readable errors.
- **`auth.ts`**: keeps a cached PingOne token in module state and refreshes it 30s before expiry. Concurrent callers share one in-flight token request. If the token can't be fetched, it logs the failure and returns `null`, and the request goes out **without** an `Authorization` header. This is deliberate, to support FHIR servers that allow unauthenticated access.
- **`http.ts`**: an Express app. It keeps sessions in an in-memory `Map` keyed by `Mcp-Session-Id`. A POST without a session must be an `initialize`. Sessions idle longer than `MCP_SESSION_IDLE_MINUTES` are swept, and new sessions get a 503 once `MCP_MAX_SESSIONS` are open. The app is **single-replica by design**: running more than one pod without sticky sessions or a shared store causes intermittent `Session not found` 404s. Node's header and request timeouts are disabled for long-lived SSE.
- **`health.ts`**: `/healthz` never touches FHIR. `/readyz` pings the CapabilityStatement and reports whether the server's `fhirVersion` starts with `4.`. Both k8s probes use `/healthz` on purpose, so that a FHIR outage doesn't evict the pod.

The source is CommonJS (`tsconfig` `module: commonjs`) but imports use `.js` suffixes (`./config.js`). Keep that convention. `ts-node.experimentalResolver` in tsconfig.json maps those back to `.ts`, and `npm run dev` and `npm test` depend on it.

## Deployment

See `infra/k8s/README.md`. Key facts:
- The target cluster nodes are **all arm64** (Graviton), so CI builds `linux/arm64` only. An amd64 image shows up as `exec format error` / CrashLoopBackOff.
- Images are pushed to `ghcr.io/robpieperping/bxhealth-fhir-mcp`. The package must be public because the manifest has no `imagePullSecret`.
- There's no Ingress; the service is in-cluster only. Verify through `kubectl port-forward`.
- App secrets live in the k8s Secret `bxhealth-fhir-mcp-secrets`. The CI ServiceAccount (`infra/k8s/ci-rbac.yaml`) deliberately can't read secrets.
- Pushing to `main` (except `.md`/docs-only changes) triggers check → build-and-push → deploy. Deploy uses `sed` to replace the manifest's `:latest` image with the commit-sha tag and applies it once, so each deploy is a single Recreate rollout. Runs queue rather than cancel each other.
