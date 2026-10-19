# bxhealth-fhir-mcp

MCP server exposing read-only tools for a FHIR R4 server, protected by OAuth 2.1.

Runs over **stdio** (an MCP host spawns the process locally) or **Streamable
HTTP** (a long-running service in Docker or Kubernetes). Over HTTP, every MCP
call requires a valid OAuth access token from the configured authorization
server (PingOne Advanced Identity Cloud in the reference setup). MCP clients
discover where to log in from the server's 401 response and open the browser
for the user automatically.

- [How authentication works](#how-authentication-works)
- [Configuration](#configuration)
- [Run locally and in Docker](#run-locally-and-in-docker)
- [Connect an MCP client](#connect-an-mcp-client)
- [HTTP routes](#http-routes)
- [Tools](#tools)
- [Testing](#testing)
- Further reading: [docs/oauth-design.md](docs/oauth-design.md) (design and decisions),
  [docs/aic-setup.md](docs/aic-setup.md) (authorization server setup),
  [docs/test-plan.md](docs/test-plan.md) (automated and manual test plan),
  [docs/cimd-plan.md](docs/cimd-plan.md) and [cimd/](cimd/README.md) (Client ID
  Metadata Documents)

## How authentication works

The server is an OAuth 2.1 **resource server**, following the MCP authorization
specification. It validates tokens; it never issues them, and it never sees the
user's password.

1. A client calls `POST /mcp` without a token.
2. The server answers `401` with
   `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource/mcp", scope="fhir-mcp:read"`.
3. The client reads that metadata (RFC 9728), which names the authorization
   server (`OAUTH_ISSUER`).
4. The client opens the user's browser for an authorization code login with
   PKCE. Its client ID is either a pre-registered public client or the HTTPS
   URL of a Client ID Metadata Document (`OAUTH_CLIENT_MODE`).
5. The authorization server issues a JWT access token whose `aud` is this
   server's `MCP_PUBLIC_URL` and whose scope includes `fhir-mcp:read`.
6. The client retries with `Authorization: Bearer <token>` and keeps sending it
   on every request.

On every request (POST, GET and DELETE on `/mcp`) the server checks the token's
signature against the issuer's JWKS, the algorithm (`OAUTH_ALGORITHMS`), the
issuer (exact match), the audience, `exp`/`nbf`, `sub`, the required scopes,
and that the token's `client_id` (or `azp`) is allowed by `OAUTH_CLIENT_MODE`.

| Result | Response |
| --- | --- |
| No token, malformed, bad signature, wrong issuer/audience, expired, client not allowed | `401`, `error="invalid_token"` plus `resource_metadata` |
| Valid token without the required scope | `403`, `error="insufficient_scope"` |
| Valid token without a usable `patient` claim (patient scoping on) | `403`, `error="insufficient_scope"` |
| Browser request from an origin not in `MCP_ALLOWED_ORIGINS` | `403` |
| Issuer metadata or JWKS unreachable | `500`; `/readyz` reports `oauth-not-ready` |

Other guarantees:

- **No unauthenticated HTTP mode.** With `MCP_TRANSPORT=http` the server
  refuses to start unless `OAUTH_ISSUER` and `MCP_PUBLIC_URL` are set, and
  both must be `https` unless they point at localhost.
- **Sessions are not credentials.** A session is bound to the identity
  (issuer, subject, client) that opened it; another identity presenting the
  same `Mcp-Session-Id` gets `404`.
- **Each member sees only their own records.** With `MCP_PATIENT_SCOPED=true`
  (the default for HTTP), the token's `patient` claim names the caller's FHIR
  Patient, and every tool call is limited to it: searches get
  `patient=Patient/{id}` forced on, other patients' ids are refused, and
  every returned resource must reference the caller. See
  [Tools](#tools) and `src/patient-scope.ts`.
- **No token passthrough.** The caller's token is never sent to FHIR. Calls to
  FHIR use the server's own credentials (`FHIR_AUTH`), or none. A
  system-level FHIR token can read every patient, which is why patient
  scoping stays on.
- **Audit log.** Each tool call writes one JSON line to stderr with the
  caller's `sub` and `client_id`, the tool name, outcome and duration. Tokens
  and tool arguments (which can contain patient data) are never logged.
- **stdio has no OAuth**, per the MCP specification: a local process is
  trusted by whoever launched it.

## Configuration

All configuration comes from environment variables, validated at startup; an
invalid or incomplete configuration stops the server with a list of the
problems. Copy the example file and fill in your own values:

```bash
cp .env.example .env
```

`.env` is read from the project root. Variables already set in the environment
take precedence. `.env` is gitignored; never commit real credentials.

### Server

| Variable | Default | Description |
| --- | --- | --- |
| `FHIR_BASE_URL` | required | FHIR R4 base URL, including the `/fhir` path |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP listen port and address |
| `MCP_READ_ONLY` | `true` | Expose only tools that cannot change FHIR data (see [Tools](#tools)) |
| `MCP_PATIENT_SCOPED` | `true` | HTTP only. Each caller sees only their own patient's data: tokens must carry the patient claim, patient-data searches get `patient=Patient/{id}` forced on, every result must reference that patient, and tools that can't be limited are hidden. Requires `MCP_READ_ONLY=true`. See `src/patient-scope.ts` |
| `OAUTH_PATIENT_CLAIM` | `patient` | Access token claim with the caller's FHIR Patient id (`123`, `Patient/123` or an absolute `.../Patient/123`). A token without it gets 403 |
| `MCP_SESSION_IDLE_MINUTES` | `30` | Close HTTP sessions idle this long |
| `MCP_MAX_SESSIONS` | `100` | Refuse new HTTP sessions (`503`) beyond this many |
| `MCP_ALLOWED_ORIGINS` | none | Comma-separated browser origins allowed to call `/mcp` (CORS). Requests without an `Origin` header (CLI and desktop clients) are always allowed |

### OAuth (required for `MCP_TRANSPORT=http`)

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_PUBLIC_URL` | required | The URL clients use to reach `/mcp`, e.g. `http://localhost:3000/mcp` or `https://fhir-mcp.example.com/mcp`. This is the OAuth resource identifier. Set it explicitly behind a load balancer; it is never derived from request headers |
| `OAUTH_ISSUER` | required | The authorization server's issuer, **exactly** as it appears in the token's `iss` claim. AIC includes `:443`, e.g. `https://<tenant>.forgeblocks.com:443/am/oauth2/realms/root/realms/alpha` |
| `OAUTH_REQUIRED_SCOPES` | `fhir-mcp:read` | Space-separated scopes every token must carry |
| `OAUTH_CLIENT_MODE` | `public` | Which clients' tokens are accepted. `public`: pre-registered client IDs. `cimd`: client IDs that are HTTPS URLs of Client ID Metadata Documents ([docs/aic-setup.md](docs/aic-setup.md), section 8). Setting the other mode's variable is a startup error |
| `OAUTH_ALLOWED_CLIENT_IDS` | none | `public` mode only. Comma-separated client IDs, e.g. `fhir-mcp-public`. If empty, any client of the issuer is accepted, with a startup warning |
| `OAUTH_CIMD_CLIENT_ID_PATTERNS` | required in `cimd` mode | Comma-separated document URLs: an exact URL, or a prefix ending in `/*`, e.g. `https://example.github.io/cimd/*`. Use the same patterns as the AIC CIMD profile |
| `OAUTH_AUDIENCE` | `MCP_PUBLIC_URL` | Value that must appear in the token's `aud`. Override only as a temporary workaround; see [docs/aic-setup.md](docs/aic-setup.md) |
| `OAUTH_JWKS_URI` | from discovery | Override for the issuer's JWKS URL |
| `OAUTH_ALGORITHMS` | `RS256,ES256` | Accepted signing algorithms. `none` and `HS*` are always refused |
| `OAUTH_CLOCK_SKEW_SECONDS` | `30` | Tolerance for `nbf`/`iat`. Expired tokens are never accepted |

At startup the server fetches the issuer's metadata
(`<issuer>/.well-known/openid-configuration`, then the RFC 8414 location) and
requires its `issuer` to equal `OAUTH_ISSUER`. A mismatch is reported in the
log and on `/readyz`, and every request fails until it is fixed.

### Outbound calls to FHIR

| Variable | Default | Description |
| --- | --- | --- |
| `FHIR_AUTH` | `none` | `none`: no `Authorization` header. `client_credentials`: the server's own token from an OAuth client_credentials grant |
| `FHIR_TOKEN_URL`, `FHIR_CLIENT_ID`, `FHIR_CLIENT_SECRET` | — | Required only with `FHIR_AUTH=client_credentials`. Any OAuth 2.0 token endpoint (AIC: `.../realms/alpha/access_token`). If a token cannot be obtained, the tool call fails; it is never sent unauthenticated. The old `PINGONE_*` variables are rejected |
| `FHIR_SCOPE` | — | Space-separated scopes requested with the grant |
| `FHIR_TOKEN_AUTH_METHOD` | `client_secret_basic` | Or `client_secret_post` |

## Run locally and in Docker

The simplest way, with nothing but Docker on the host:

```bash
docker compose up --build -d                         # HTTP on http://localhost:3000/mcp, config from .env
docker compose logs -f mcp
docker build -f infra/Dockerfile --target check .   # typecheck and tests
```

After changing only `.env`, run `docker compose up -d --force-recreate`; the
container reads `.env` when it is created. Inside the container `localhost`
is the container itself: reach services on the host at
`host.docker.internal`. Without Compose:

```bash
docker build -f infra/Dockerfile -t bxhealth-fhir-mcp .
docker run --rm -p 3000:3000 --env-file .env bxhealth-fhir-mcp
```

Without Docker, Node.js 22.12 or later is required:

```bash
npm install
npm run build
npm start            # stdio
npm run start:http   # Streamable HTTP; needs the OAuth settings
npm run dev          # stdio, live TypeScript
npm run dev:http     # HTTP, live TypeScript
```

`.env` is read the same way in both cases: `#` starts a comment line, or an
inline comment after whitespace, and quoted values keep a `#`.

The image defaults to `MCP_TRANSPORT=http` and runs as UID 1000. For Docker on
your machine, `MCP_PUBLIC_URL=http://localhost:3000/mcp` (match the published
port). Check it is up and wired correctly:

```bash
curl -s localhost:3000/healthz
curl -s localhost:3000/readyz      # oauth state + FHIR fhirVersion
curl -s localhost:3000/.well-known/oauth-protected-resource/mcp
curl -si -X POST localhost:3000/mcp -H 'Content-Type: application/json' -d '{}' | grep -i www-authenticate
```

## Connect an MCP client

Before connecting, the authorization server must issue tokens with the right
audience, scope and `patient` claim, and accept the client: a pre-registered
public client, or a CIMD profile; see [docs/aic-setup.md](docs/aic-setup.md).
The tenant's Content Security Policy must also allow each client's local
callback, or the browser stays on the consent page after **Allow**
([docs/aic-setup.md](docs/aic-setup.md), section 8, step 10).

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Choose **Streamable HTTP**, URL `http://localhost:3000/mcp`. In the
authentication settings enter the client ID (the public client, or in `cimd`
mode the URL of `mcp-inspector.json`) and scope `openid fhir-mcp:read`, then
connect. The Inspector opens the browser for the
AIC login and returns with a token. Its callback URL
(`http://localhost:6274/oauth/callback` by default) must be registered on the
client. If you use the Inspector's direct (browser) connection mode instead of
its proxy, add its origin to `MCP_ALLOWED_ORIGINS`, e.g.
`MCP_ALLOWED_ORIGINS=http://localhost:6274`.

### Claude Code

In `cimd` mode, give Claude Code the document URL as its client ID and the
callback port the document lists (`http://localhost:8765/callback`):

```bash
claude mcp add --transport http \
  --client-id https://<host>/<path>/claude-code.json \
  --callback-port 8765 \
  bxhealth-fhir http://localhost:3000/mcp
```

In `public` mode, use the pre-registered client ID instead, with
`http://localhost:8765/callback` registered on that client. Then run `/mcp`
in Claude Code, select the server and choose **Authenticate**; the browser
opens for the login. New servers appear in `/mcp` only in sessions started
after `claude mcp add`.

### Claude Desktop and claude.ai

Custom connectors connect from Anthropic's infrastructure, so they need a
public HTTPS `MCP_PUBLIC_URL`; they cannot reach `localhost`. Test these once
the server is deployed.

### stdio registration (no OAuth)

`mcp.json` shows a local stdio registration; adjust the path:

```json
{
  "mcpServers": {
    "bxhealth-fhir-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/bxhealth-fhir-mcp/dist/index.js"],
      "env": { "FHIR_BASE_URL": "https://your-fhir-server.example.com/fhir" }
    }
  }
}
```

## HTTP routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /mcp` | Bearer token | JSON-RPC requests. A request without `Mcp-Session-Id` must be `initialize`; the response carries the new session id |
| `GET /mcp` | Bearer token | The SSE stream for an established session |
| `DELETE /mcp` | Bearer token | Ends a session |
| `GET /.well-known/oauth-protected-resource/mcp` | none | Protected Resource Metadata (RFC 9728); also served at `/.well-known/oauth-protected-resource` |
| `GET /healthz` | none | Liveness. Touches neither FHIR nor the authorization server |
| `GET /readyz` | none | Readiness: issuer metadata resolved, then FHIR CapabilityStatement reachable; reports the FHIR server's `fhirVersion` |

Sessions are held in memory, so the HTTP service is **single-replica** unless
sticky sessions or a shared session store are added first.

## App-hosted CIMD documents

HTTP mode serves public JSON at `/cimd/claude-code.json`,
`/cimd/gemini-cli.json`, `/cimd/mcp-inspector.json`, and `/cimd/vscode.json`.
Each document's client ID uses the origin of `MCP_PUBLIC_URL`; no OAuth is
required to fetch it. Use a public HTTPS host reachable by AIC, not localhost.
Callback URIs remain on the client machine. See [cimd/README.md](cimd/README.md)
and the [Kubernetes deployment guide](infra/k8s/README.md) for cutover steps.

## Tools

Tools are listed with the MCP `readOnlyHint` annotation. With
`MCP_READ_ONLY=true` (the default) only read-only tools are listed, and calls
to the others are rejected as unknown tools.

With patient scoping on (the HTTP default), only the tools marked
"Patient-scoped: yes" are listed, and they default to the signed-in member:
`patientId` can be left out, and any other patient's id is refused.
Searching Patient with no parameters returns the member's own record.
Patient-data types (Observation, Condition, Claim and so on) and a list of
shared types (Practitioner, Organization, Medication, terminology) are
available; other types, such as Binary, are refused.

| Tool | Read-only | Patient-scoped | Purpose |
| --- | --- | --- | --- |
| `fhir_get_metadata` | yes | yes | Server CapabilityStatement |
| `fhir_read_resource` | yes | yes | Read a resource |
| `fhir_vread_resource` | yes | no | Read a resource at a version |
| `fhir_search_resources` | yes | yes | Search any resource type |
| `fhir_resource_history` / `fhir_type_history` | yes | no | History for one resource or a whole type |
| `fhir_patient_everything` | yes | yes | `Patient/$everything` |
| `fhir_validate_resource` | yes | yes | `$validate` (POSTs the resource but stores nothing) |
| `fhir_search_observations`, `_conditions`, `_medication_requests`, `_encounters` | yes | yes | Convenience searches |
| `fhir_search_patients` | yes | no | Patient search by demographics |
| `fhir_create_resource` / `fhir_update_resource` / `fhir_patch_resource` / `fhir_delete_resource` | no | no | Write operations |
| `fhir_transaction` | no | no | Transaction or batch Bundle |
| `fhir_execute_operation` | no | no | Any `$operation`, including ones that modify data |

## Testing

```bash
docker build -f infra/Dockerfile --target check .   # typecheck and tests, in Docker
npm test                                     # all suites
npm test -- --test-name-pattern="audience"   # matching tests only
```

The suites run against local stub servers: a stub issuer that serves OIDC
discovery and a JWKS from keys generated in the test, and a stub FHIR server.
No network or real authorization server is needed, and CI runs them on every
push. Manual end-to-end steps for Docker and Kubernetes are in
[docs/test-plan.md](docs/test-plan.md).

Deployment to Kubernetes is described in [infra/k8s/README.md](infra/k8s/README.md).
