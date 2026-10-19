# Test plan: OAuth phase 1

Phase 1 is done when:

- all of section A passes in CI,
- every step of section B passes with MCP Inspector and Claude Code against
  your AIC tenant, and
- read-only tools return live FHIR data only when a valid token is presented.

## A. Automated tests (`npm test`)

These run without network access or a real authorization server, and CI runs
them on every push. `test/oauth.test.ts` starts:

- a stub issuer, serving OIDC discovery and a JWKS from keys generated in the
  test, so tokens can be minted with any claims,
- a stub FHIR server, and
- the real HTTP app.

| Area | Cases | File |
| --- | --- | --- |
| 401 challenge | No header → 401 with `resource_metadata` and `scope` in `WWW-Authenticate`. Basic scheme, empty bearer, garbage and `a.b.c` tokens → 401 | `oauth.test.ts` |
| Valid tokens | RS256 and ES256 accepted. `aud` array containing ours accepted. `scp` array accepted. Full flow, with patient scoping off: initialize → tools/list (13 tools, all `readOnlyHint`) → tool call returns FHIR data | `oauth.test.ts` |
| Read-only | Write tools absent from the list. Calling `fhir_delete_resource` by name → "Unknown tool". (stdio uses the same filter; checked manually) | `oauth.test.ts` |
| Signature and algorithm | Unpublished key with a known `kid`, tampered payload, `alg: none`, HS256 with a shared secret, RS512 (valid key but not in the allowlist): all 401 | `oauth.test.ts` |
| Time | Expired → 401. Expired by less than the skew → still 401. `nbf` beyond the skew → 401. `nbf` within the skew → accepted. Missing `exp` → 401 | `oauth.test.ts` |
| Issuer, audience, subject | Wrong issuer, trailing slash, different host spelling, wrong `aud`, missing `aud`, missing `sub`: all 401 | `oauth.test.ts` |
| Scope | Missing scope → 403 with `error="insufficient_scope"` and the required scope | `oauth.test.ts` |
| Key rotation | A new key in the JWKS is accepted after exactly one refetch. Repeated unknown `kid`s within the cooldown don't refetch | `oauth.test.ts` |
| Sessions | GET and DELETE without a token → 401. Another `sub` using the session → 404. Same user with a refreshed token keeps the session and can delete it | `oauth.test.ts` |
| Public endpoints | Metadata at both paths with the exact expected body. `/healthz` without a token. `/readyz` reports OAuth ready and the FHIR version | `oauth.test.ts` |
| Origin | Disallowed origin → 403 before auth. Allowed origin preflight → 204 with CORS headers, which also appear on the 401 | `oauth.test.ts` |
| Logging | Audit line has `sub`, `client_id`, tool and outcome. The raw token, its signature and the tool arguments never appear in logs | `oauth.test.ts` |
| Issuer discovery | Mismatched issuer is a permanent error, reported on status and never retried. Unreachable issuer is reported, then retried | `oauth.test.ts` |
| Configuration | HTTP refuses to start without `MCP_PUBLIC_URL`/`OAUTH_ISSUER`. `http://` is refused except for localhost. Fragments and relative URLs refused. `none`/`HS256` refused. Defaults and overrides. `MCP_READ_ONLY` parsing. `client_credentials` requires `FHIR_TOKEN_URL`/`FHIR_CLIENT_ID`/`FHIR_CLIENT_SECRET`; old `PINGONE_*` rejected. Patient scoping on by default and needs read-only | `config.test.ts` |
| FHIR client | Repeated array parameters, path validation, `$operation` paths, client_credentials request (grant, scope, Basic credentials), one shared token fetch, 401 retry once, no retry loop | `fhir-client.test.ts` |
| Patient scoping | Unscopable tools hidden. Searches and reads get `patient=Patient/{id}` forced on. Patient pinned to own id. Shared types pass, others refused. `_revinclude`/`_has`/`_contained`/`_filter` refused. Resources not referencing the caller (including via `contained` only, or `Patient/p10` vs `p1`) filtered out of searches, reads and `$everything`. Pass-through without a patient | `patient-scope.test.ts` |
| Patient claim | Bare id, `Patient/id` and absolute references accepted; other types, invalid ids and non-strings refused; missing claim is 403 | `patient-claim.test.ts`, `oauth.test.ts` |
| FHIR auth none | No token request and no `Authorization` header | `fhir-auth-none.test.ts` |

The suite was checked by deliberately disabling three protections: the
audience check, session binding and the algorithm allowlist. Each time, the
corresponding tests failed.

## B. Manual: Docker on your Mac, against your AIC tenant

Prerequisites: [aic-setup.md](aic-setup.md) completed, including its step 6
checklist, plus a `.env` with your FHIR URL, `MCP_PUBLIC_URL` and
`OAUTH_ISSUER`. Patient scoping is on (the default), and the test members of
aic-setup.md section 5 exist.

| # | Step | Expected |
| --- | --- | --- |
| B1 | `docker compose up --build -d`, then `docker compose logs mcp` | Log shows the listening URL, the OAuth resource and issuer, and `[oauth] issuer ... ready` |
| B2 | `curl -s localhost:3000/healthz` and `curl -s localhost:3000/readyz` | 200 for both. `readyz` shows `oauth.state: ready` and your FHIR server's `fhirVersion` (4.x) |
| B3 | `curl -s localhost:3000/.well-known/oauth-protected-resource/mcp` | `resource` = `MCP_PUBLIC_URL`, `authorization_servers` = `[OAUTH_ISSUER]`, `scopes_supported` = `["fhir-mcp:read"]` |
| B4 | `curl -si -X POST localhost:3000/mcp -H 'Content-Type: application/json' -d '{}'` | `401` with `WWW-Authenticate: Bearer ... resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"` |
| B5 | MCP Inspector: Streamable HTTP, `http://localhost:3000/mcp`, client ID, scope `openid fhir-mcp:read`, then connect | Browser opens the AIC login. After login the Inspector connects |
| B6 | Inspector: List Tools | 9 tools. No writes, `fhir_execute_operation`, `fhir_search_patients`, vread or history |
| B7 | Inspector: `fhir_search_resources` with `resourceType: Patient` and no parameters, then `fhir_get_metadata` | Only the member's own Patient (the `self` link has `_id=<their id>`), and the CapabilityStatement |
| B8 | Claude Code: `claude mcp add --transport http bxhealth-fhir http://localhost:3000/mcp`, then `/mcp` and authenticate | Browser login, then the server shows as connected |
| B9 | Claude Code: ask about "my conditions" or "my recent lab results" | Only the signed-in member's data |
| B10 | Log in as the user (or client) without `fhir-mcp:read` | `403 insufficient_scope`. No tools are callable |
| B11 | Decode the Inspector's token (command in [aic-setup.md](aic-setup.md)) | `iss` = `OAUTH_ISSUER` exactly, `aud` = `MCP_PUBLIC_URL`, `scope` includes `fhir-mcp:read` |
| B12 | Send a request with the token's last character changed (curl with `-H "Authorization: Bearer ..."`) | `401 invalid_token` |
| B13 | Wait past the token lifetime (or shorten it in AIC for the test), then call a tool | `401`. The client logs in again or refreshes |
| B14 | Restart the container while a client is connected | Client gets `404 Session not found`, re-initializes, and works with its existing token |
| B15 | `docker logs <container>` | `tool_call` audit lines with your `sub`. No token strings, no patient names or search values |
| B16 | Run without `OAUTH_ISSUER` | Container exits immediately with "OAUTH_ISSUER is required" |
| B17 | Run with a wrong `OAUTH_ISSUER` (e.g. without `:443`) | `/readyz` 503 with "must match exactly". Tool calls fail |
| B18 | Claude Code: ask for another patient's data by id | `Access denied: patient="<id>" is not you`. Nothing for that patient is fetched |
| B19 | Sign in as the second test member and repeat B7 | Their own Patient, a different id from B7 |
| B20 | Sign in as the member without the patient attribute | `403`. Log: `no usable "patient" claim (sub=...)` |
| B21 | With a short access token lifetime: let the token expire while signed in to AIC, then call a tool. Sign out of AIC in the browser and repeat | Signed in: the refresh works and calls continue. Signed out: the refresh is refused and the client asks you to sign in again; no `403` in the log |
| B22 | With `FHIR_AUTH=client_credentials` against the agent endpoint, `curl -s localhost:3000/readyz` | `fhir.versionMatches: true`. A bad secret instead gives a `[fhir-auth]` log line with AIC's error |

Claude Desktop and claude.ai connectors can't reach `localhost`, so they are
tested in section C.

## C. Manual: Kubernetes on AWS

Prerequisites: your own namespace, image registry, TLS Ingress and Secret, with
`MCP_PUBLIC_URL=https://<your-host>/mcp`. Add that URL to the AIC audience
configuration. None of the existing `infra/k8s` or CI resources are used for
this.

| # | Step | Expected |
| --- | --- | --- |
| C1 | `curl -s https://<host>/.well-known/oauth-protected-resource/mcp` | `resource` is the https URL, not a pod or service address |
| C2 | `curl -si -X POST https://<host>/mcp -d '{}'` | 401 whose `resource_metadata` uses the https host |
| C3 | Repeat B5 to B15 through the public host | Same results |
| C4 | Claude Desktop or claude.ai: add a custom connector for `https://<host>/mcp` | Browser login, tools usable |
| C5 | Liveness and readiness probes | Pod stays healthy with no token. A brief AIC outage doesn't restart the pod |
| C6 | From a pod not allowed by the NetworkPolicy, `curl` the service | Connection refused or timed out |
| C7 | Rotate the AIC signing key, or follow AIC's key rollover procedure | New tokens accepted without restarting the server. Old tokens accepted until they expire if the old key is still published |
| C8 | `kubectl logs` | Same as B15 |

## D. Manual: CIMD clients (`OAUTH_CLIENT_MODE=cimd`)

Prerequisites: the documents in `cimd/` are hosted and the AIC CIMD profile is
set up ([aic-setup.md](aic-setup.md), section 8). The server runs locally
with `OAUTH_CLIENT_MODE=cimd` and `OAUTH_CIMD_CLIENT_ID_PATTERNS` set to the
profile's pattern.

| # | Step | Expected |
| --- | --- | --- |
| D1 | The `curl` check in [cimd/README.md](../cimd/README.md), for each document | `200`, no redirect, at most 5 KB, `client_id` equals the URL |
| D2 | Start the server | Log line `client mode cimd; client ID patterns: ...`. `/readyz` has `"clientMode": "cimd"` |
| D3 | Connect the Inspector with the document URL as client ID, then decode the token | Consent shows the client. `client_id` (or `azp`) is the document URL, `aud` = `MCP_PUBLIC_URL`, `scope` is only `fhir-mcp:read` |
| D4 | `claude mcp add ... --client-id <claude-code.json URL> --callback-port 8765`, then `/mcp` > Authenticate, then a FHIR search | Tools work. The audit line's `client_id` is the document URL |
| D5 | Use a client ID URL outside the profile's pattern | AIC refuses with `invalid_client` before the login page |
| D6 | Use a `redirect_uri` not in the document (e.g. a different callback port) | AIC refuses the authorization request |
| D7 | Host a copy of a document whose `client_id` differs from its URL | AIC refuses the client |
| D8 | Have a document ask for more scope (e.g. `"scope": "fhir-mcp:read openid profile"`) | The token still carries only the profile's scopes |
| D9 | With the server in `cimd` mode, connect with `fhir-mcp-public` | Login succeeds at AIC, but the server returns `401`. Log: `client_id is not a canonical https metadata document URL (client_id="fhir-mcp-public")` |
| D10 | Switch to `OAUTH_CLIENT_MODE=public` with `OAUTH_ALLOWED_CLIENT_IDS=fhir-mcp-public`, then connect with a CIMD client | `401`. Log: `client_id is not in OAUTH_ALLOWED_CLIENT_IDS` |
| D11 | Set `OAUTH_CLIENT_MODE=cimd` without `OAUTH_CIMD_CLIENT_ID_PATTERNS` | The server exits at startup with "is required when OAUTH_CLIENT_MODE=cimd" |

## Regression checks for every change

- `docker build -f infra/Dockerfile --target check .` (runs `npm run typecheck && npm test`; the runtime build runs `npm run build`)
- B2 to B4 against a local container (a two-minute smoke test of the auth
  wiring)
