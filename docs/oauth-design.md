# OAuth design (phase 1)

Phase 1 makes the MCP server an OAuth 2.1 resource server: every HTTP call to
`/mcp` needs a valid access token from the configured authorization server,
and MCP clients log the user in through the browser when they don't have one.
Tools are read-only in this phase.

Built since phase 1:

- **OAuth from the MCP server to FHIR.** `FHIR_AUTH=client_credentials` gets
  the server's own system-level token (aic-setup.md, section 9).
- **Patient scoping.** Each member is limited to their own records; see
  "Patient scoping" below.

Later phases, not built yet:

- **Token exchange (RFC 8693)** for a delegated token, so FHIR sees the user
  rather than the server. Smile CDR's agent endpoint accepts only system
  tokens, so this would need a FHIR endpoint that takes patient-scoped
  tokens.
- **A gateway** in front of the server. The server keeps validating tokens
  itself even then, so bypassing the gateway does not grant access.
- **Write tools,** behind their own scope.

## Standards followed

| Standard | Where |
| --- | --- |
| MCP Authorization spec (2025-06-18 and later) | Overall model: resource server, 401 challenge, metadata discovery, no token passthrough |
| OAuth 2.1 | Authorization code + PKCE (S256) on the client side; bearer tokens in the `Authorization` header only |
| RFC 9728 Protected Resource Metadata | `/.well-known/oauth-protected-resource/mcp`, advertised in `WWW-Authenticate` |
| RFC 6750 Bearer tokens | `WWW-Authenticate` with `invalid_token` (401) and `insufficient_scope` (403) |
| RFC 8414 / OpenID Connect Discovery | The server discovers the issuer's `jwks_uri` and checks its `issuer` |
| RFC 9068 JWT access tokens | Validation rules: `iss`, `aud`, `exp`, `sub`, `scope` |
| RFC 8707 Resource Indicators | The audience is the server's own URL. AIC ignores the `resource` parameter, so the audience is set on the provider instead ([aic-setup.md](aic-setup.md)) |

## Request flow

```
MCP client                 MCP server                       AIC (issuer)
    | POST /mcp (no token)     |                                 |
    |------------------------->|                                 |
    | 401 WWW-Authenticate:    |                                 |
    |   resource_metadata=...  |                                 |
    |<-------------------------|                                 |
    | GET /.well-known/oauth-protected-resource/mcp              |
    |------------------------->|                                 |
    | { authorization_servers: [OAUTH_ISSUER], scopes_supported }|
    |<-------------------------|                                 |
    | GET <issuer>/.well-known/openid-configuration              |
    |----------------------------------------------------------->|
    | browser: /authorize (code + PKCE S256) ... user logs in    |
    |----------------------------------------------------------->|
    | POST /access_token (code + code_verifier)                  |
    |----------------------------------------------------------->|
    | JWT access token (aud = MCP_PUBLIC_URL, scope fhir-mcp:read)
    |<-----------------------------------------------------------|
    | POST /mcp  Authorization: Bearer <JWT>                     |
    |------------------------->| verify signature (JWKS, cached) |
    |                          | iss, aud, exp/nbf, alg, sub, scope
    | 200                      |                                 |
    |<-------------------------|                                 |
```

## Components

| File | Responsibility |
| --- | --- |
| `src/config-schema.ts` | Parses and validates the environment (Zod). Applies the fail-closed rules: HTTP requires the OAuth settings, URLs must be `https` except on localhost, and `none`/`HS*` algorithms are refused |
| `src/oauth/discovery.ts` | Fetches issuer metadata (OpenID form, then RFC 8414) and requires an exact `issuer` match |
| `src/oauth/verifier.ts` | Implements the SDK's `OAuthTokenVerifier` with `jose`: remote JWKS with caching, refetch on an unknown `kid` (rate-limited), and the claim checks. Errors returned to clients are generic; details go to the server log |
| `src/oauth/metadata.ts` | Protected Resource Metadata document and URL |
| `src/origin.ts` | `Origin` validation (DNS-rebinding protection) and CORS for allowed browser origins |
| `src/http.ts` | Wiring: public routes, then the origin check, then the SDK's `requireBearerAuth` on every `/mcp` method. Sessions are bound to their owner |
| `src/server.ts` | Read-only filtering, the `readOnlyHint` annotation, and the per-call audit log (using the SDK's `extra.authInfo`) |

## Decisions

**Local JWT validation, not introspection.** It's fast, needs no client
credentials on the server, and AM's introspection response omits `aud`.
The cost is revocation: a revoked token stays valid until `exp`. Short token
lifetimes are the mitigation. The verifier is a separate component, so
introspection can be added later if revocation becomes a requirement.

**The SDK's `requireBearerAuth`.** It produces the spec-shaped 401/403 and
`WWW-Authenticate` headers and exposes `req.auth` to the MCP handlers. One
consequence: it checks `exp` against the clock with no skew, so
`OAUTH_CLOCK_SKEW_SECONDS` effectively applies to `nbf`/`iat` only. An expired
token is never accepted.

**Exact issuer match, including the port.** AIC's `iss` includes `:443`.
Normalising the URL would hide a real mismatch between the configured and
actual issuer, so the server compares strings exactly, both against the token
and against the discovery document at startup.

**Issuer problems don't crash the process.** If discovery fails at startup,
`/healthz` stays up (so Kubernetes doesn't restart-loop the pod), `/readyz`
reports `oauth-not-ready`, requests get `500`, and discovery is retried on the
next request. A *mismatched* issuer is a configuration error: it is never
retried and stays reported until the configuration is fixed and the server
restarted.

**Session binding.** Every request carries and is checked for a token. The
session also records `[iss, sub, client_id]` from the token that opened it,
and other identities get the same `404` as for an unknown session. A token
refresh for the same user keeps the session.

**Which clients are accepted (`OAUTH_CLIENT_MODE`).** The authorization
server decides who gets a token, but any client in the realm can ask for one
with this server as the audience. So the server also checks the token's
`client_id` (or `azp`). In `public` mode it must be in
`OAUTH_ALLOWED_CLIENT_IDS`; an empty list accepts any client, for
compatibility, with a warning at startup. In `cimd` mode it must be the
HTTPS URL of a Client ID Metadata Document matching
`OAUTH_CIMD_CLIENT_ID_PATTERNS` (an exact URL, or a prefix ending in `/*`,
the same syntax as an AIC CIMD profile). The URL must be in canonical form,
so the string checked is the one the authorization server fetched. A
refused client gets the same generic `401` as any other bad token; the log
says why. Each mode has its own variable, and setting the other's is a
startup error. Details: [cimd-plan.md](cimd-plan.md).

**Read-only via an explicit per-tool flag.** Every tool must declare
`readOnly`, so a new tool can't be added without classifying it.
`fhir_execute_operation` is classed as a write tool, since it can invoke any
operation. `fhir_validate_resource` is read-only, because `$validate` stores
nothing.

**Patient scoping (`MCP_PATIENT_SCOPED`, on by default for HTTP).** The
outbound FHIR token is system-level and can read every patient, so the
server itself limits each caller to one patient. The verifier reads the
caller's Patient id from the token's `patient` claim (`OAUTH_PATIENT_CLAIM`),
set by the authorization server from the member's login, and refuses a
token without one with `403`. `src/patient-scope.ts` then:

- forces `patient=Patient/{id}` onto searches and reads of patient-data
  types. Compartment search (`/Patient/{id}/{type}`) would be the textbook
  way, but Smile CDR answers it with `400`;
- refuses any other patient's id, rather than silently replacing it, so the
  model never presents the member's data as someone else's;
- allows a fixed list of shared types and refuses every other type;
- refuses `_revinclude`, `_has`, `_contained`, `_filter` and `_query`;
- drops any returned resource that doesn't reference the caller's Patient,
  which also covers `_include`, `$everything`, and a FHIR server that
  ignores the forced parameter;
- hides the tools it can't limit (patient search, vread, history, writes).
  Patient scoping requires `MCP_READ_ONLY=true`.

Every rule fails closed: an unknown type or parameter is refused, and Smile
CDR rejects unknown search parameters with `400`.

**What is never logged:** raw tokens and tool arguments. Arguments can contain
names, identifiers and other patient data.

## Limitations in phase 1

- Revocation is not detected before `exp` (see above).
- Sessions live in memory, so the service runs as a single replica.
- Dynamic Client Registration is not supported. MCP clients use a
  pre-registered public client, or a Client ID Metadata Document in
  `OAUTH_CLIENT_MODE=cimd`.
- Only bearer tokens in the `Authorization` header are accepted, not query
  parameters or form bodies, as OAuth 2.1 requires.
- Under patient scoping, members can't read `_include`d resources unless
  they reference the member (or are shared types), Binary attachments,
  history, or versions.
- FHIR sees every call as the server, not the member. The server's audit
  log is the only record of which member asked.
