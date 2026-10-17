# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server that exposes FHIR R4 operations as tools (read-only by default). It runs over stdio, where an MCP host spawns the process and there is no OAuth, or over Streamable HTTP, where it is an OAuth 2.1 resource server: every `/mcp` request needs a JWT access token from `OAUTH_ISSUER` (PingOne AIC in the reference setup). Design and rationale: `docs/oauth-design.md`. Authorization server setup: `docs/aic-setup.md`. Test plan, including manual Docker/AWS steps: `docs/test-plan.md`.

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

There is no linter. CI (`.github/workflows/deploy-main.yml`) runs `typecheck`, `test` and `build` before it builds the image and deploys.

Tests in `test/` run each file in its own process, because config is read once at import time. Each file sets `process.env` and starts its stubs before `require()`-ing `src/`. `test/oauth.test.ts` runs a stub issuer (OIDC discovery plus a JWKS from keys generated with `jose`), mints tokens with `mint(claims, key, omit)`, and drives the real Express app with `fetch`. The SSE responses are parsed in the `mcp()` helper. A test that needs different config (for example a different `FHIR_AUTH`) goes in a new file. `parseConfig` in `src/config-schema.ts` is pure, so config rules are tested directly in `test/config.test.ts`. Set `TEST_VERBOSE=1` to see server logs from the OAuth suite.

Configuration comes from env vars, loaded from `.env` in the project root (copy `.env.example`). Variables already set in the environment take precedence over `.env`. All validation is in `src/config-schema.ts` (Zod). It fails closed: `MCP_TRANSPORT=http` refuses to start without `MCP_PUBLIC_URL` and `OAUTH_ISSUER`, and URLs must be https unless on localhost. `OAUTH_CLIENT_MODE` (`public` | `cimd`) selects which token `client_id`s are accepted: `OAUTH_ALLOWED_CLIENT_IDS` in public mode, `OAUTH_CIMD_CLIENT_ID_PATTERNS` (required) in cimd mode, and setting the other mode's variable is an error. Don't add a way to run HTTP without auth. `typecheck` and `build` need no env vars.

## Architecture

Request flow (HTTP): `http.ts` origin check → SDK `requireBearerAuth` with `oauth/verifier.ts` → session lookup (bound to the token's identity) → `server.ts` (`createServer`) → `tools.ts` handler → `fhir-client.ts` → `auth.ts` for the outbound FHIR token (if `FHIR_AUTH=client_credentials`).

- **`index.ts`**: picks the transport from `MCP_TRANSPORT` (`stdio` | `http`). In stdio mode, stdout is the protocol channel, so all logging must use `console.error`.
- **`server.ts`**: `createServer()` builds a new MCP `Server` on every call. A `Server` can connect to only one transport, and the HTTP transport is per-session. Don't hoist it into a module-level singleton. With `MCP_READ_ONLY=true` (default), tools with `readOnly: false` are neither listed nor callable, and every listed tool carries the `readOnlyHint` annotation. Tool input is validated with each tool's Zod schema. Handler errors come back as `isError` text content rather than thrown MCP errors. Each call writes a JSON audit line (`sub`, `client_id`, tool, outcome) from `extra.authInfo`. Never log tokens or tool arguments, since arguments can contain patient data.
- **Hand-rolled Zod → JSON Schema** (`buildJsonSchema` in `server.ts`): it handles only Object, Optional, Default, String, Number, Boolean, Array, Record, Enum, Union, Unknown and Any. Any other Zod type, such as `nullable`, `literal`, `.refine()`/effects or nested `describe` wrappers, falls through to `{ description }`, which leaves clients with an empty schema. Extend this function if a new tool needs one of those types.
- **`tools.ts`**: one flat `tools: ToolDefinition[]` array. Each entry is wrapped in `defineTool({...})`, which types the handler's `input` from the Zod `inputSchema`, so don't cast `input`. Every tool must set `readOnly`. Set it to `true` only if the tool can't change FHIR data (`fhir_execute_operation` is `false` because it can run any operation). Handlers return a string (usually `JSON.stringify(..., null, 2)`). Add a tool by appending an entry here. No registration is needed elsewhere.
- **`fhir-client.ts`**: one shared axios instance against `FHIR_BASE_URL`, using `application/fhir+json` and `Prefer: return=representation`. `paramsSerializer: { indexes: null }` sends arrays as repeated keys (`date=a&date=b`), which FHIR requires. Build every URL path with `resourcePath()`/`operationSegment()`, which validate resource types, FHIR ids and operation names; never interpolate tool input into a path directly. On a 401 it clears the token cache and retries once. It turns FHIR `OperationOutcome` responses into readable errors.
- **`auth.ts`**: handles outbound auth to FHIR only, using the server's own identity. `FHIR_AUTH=none` returns `null` (no header). `client_credentials` caches a PingOne token, refreshes it 30s before expiry, and shares one in-flight request between callers. If a token can't be fetched it **throws**, so a request is never sent unauthenticated. The MCP caller's token is never forwarded to FHIR, because the MCP spec forbids token passthrough. Delegated access is planned as a later token-exchange phase.
- **`oauth/verifier.ts`**: `JwtTokenVerifier` implements the SDK's `OAuthTokenVerifier` with `jose`. It verifies against the remote JWKS (cached, refetched on an unknown `kid` at most every 30s), then checks the algorithm allowlist, exact `iss`, `aud`, `exp`/`nbf`, and `sub`. The SDK middleware checks scopes and `exp` (with no skew). Errors returned to clients are generic and the details are logged. Discovery (`oauth/discovery.ts`) runs lazily and is retried after transient failures. An issuer mismatch with the discovery document is permanent until restart. `/readyz` reports its state.
- **`oauth/client-policy.ts`**: pure `clientRejection(clientId, policy)`, called by the verifier after the JWT checks. In cimd mode the `client_id` must be a canonical https URL (`new URL(id).href === id`) matching an exact-URL or `/*`-prefix pattern; never loosen that canonical check, since it guarantees the URL matched is the one the authorization server fetched. `patternProblem` validates patterns for `config-schema.ts`. Design and AIC steps: `docs/cimd-plan.md`, `docs/aic-setup.md` section 8. Document templates: `cimd/`.
- **`oauth/metadata.ts`**: RFC 9728 metadata served at `/.well-known/oauth-protected-resource/mcp` and the root form. Its URL goes in the 401 `WWW-Authenticate`. `authorization_servers` is `OAUTH_ISSUER` verbatim.
- **`origin.ts`**: rejects browser `Origin`s not in `MCP_ALLOWED_ORIGINS` (DNS-rebinding protection), and adds CORS headers (exposing `WWW-Authenticate` and `Mcp-Session-Id`) for allowed ones.
- **`http.ts`**: an Express app. Health and metadata routes are public. Everything under `/mcp` goes through the origin check, then `requireBearerAuth`. Sessions live in an in-memory `Map` keyed by `Mcp-Session-Id`, each storing the `[iss, sub, client_id]` that opened it. Another identity using that session ID gets the same 404 as an unknown session. A POST without a session must be an `initialize`. `buildApp({ verifier })` accepts an injected verifier for tests. Sessions idle longer than `MCP_SESSION_IDLE_MINUTES` are swept, and new sessions get a 503 once `MCP_MAX_SESSIONS` are open. The app is **single-replica by design**: running more than one pod without sticky sessions or a shared store causes intermittent `Session not found` 404s. Node's header and request timeouts are disabled for long-lived SSE.
- **`health.ts`**: `/healthz` touches neither FHIR nor the issuer. `/readyz` first requires OAuth discovery to be ready, then pings the CapabilityStatement and reports whether the server's `fhirVersion` starts with `4.`. Both k8s probes use `/healthz` on purpose, so that a FHIR outage doesn't evict the pod.

The source is CommonJS (`tsconfig` `module: commonjs`) but imports use `.js` suffixes (`./config.js`). Keep that convention. `ts-node.experimentalResolver` in tsconfig.json maps those back to `.ts`, and `npm run dev` and `npm test` depend on it. `jose` v6 is ESM-only and is loaded through Node's `require(esm)`, so Node ≥ 22.12 is required (`engines`, `node:22-alpine`, CI Node 22).

## Deployment

The `infra/k8s` manifests and `deploy-main.yml` target the original author's cluster, namespace and GHCR image. Treat them as reference only. Deploying this fork to another environment (planned: AWS) needs its own manifests, registry, Secret and CI, with `MCP_PUBLIC_URL` set to the public https URL. See `infra/k8s/README.md`. Key facts about the existing setup:
- The target cluster nodes are **all arm64** (Graviton), so CI builds `linux/arm64` only. An amd64 image shows up as `exec format error` / CrashLoopBackOff.
- Images are pushed to `ghcr.io/robpieperping/bxhealth-fhir-mcp`. The package must be public because the manifest has no `imagePullSecret`.
- There's no Ingress; the service is in-cluster only. Verify through `kubectl port-forward`.
- App secrets live in the k8s Secret `bxhealth-fhir-mcp-secrets`. The CI ServiceAccount (`infra/k8s/ci-rbac.yaml`) deliberately can't read secrets.
- Pushing to `main` (except `.md`/docs-only changes) triggers check → build-and-push → deploy. Deploy uses `sed` to replace the manifest's `:latest` image with the commit-sha tag and applies it once, so each deploy is a single Recreate rollout. Runs queue rather than cancel each other.
