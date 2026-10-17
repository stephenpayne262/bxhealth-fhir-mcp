# Plan: Client ID Metadata Documents (CIMD) with PingOne AIC

Status: proposed. Branch: `PayneUpdate-cimd`. Builds on phase 1
([oauth-design.md](oauth-design.md)), where MCP clients log in through the
pre-registered public client `fhir-mcp-public`.

## Goal

Let MCP clients identify themselves to AIC with a Client ID Metadata Document
instead of a client someone pre-registered in AIC, and let the server be
switched between the two models with one `.env` setting:

```bash
OAUTH_CLIENT_MODE=public   # today's model: pre-registered client IDs
OAUTH_CLIENT_MODE=cimd     # client IDs are HTTPS URLs to metadata documents
```

## Who does what

CIMD is an agreement between the **MCP client** and **AIC**. The MCP server is
the resource server and never sees the metadata document.

| Party | Public client (today) | CIMD |
| --- | --- | --- |
| MCP client (Claude Code, Inspector) | Sends `client_id=fhir-mcp-public` | Sends `client_id=https://…/client.json` |
| AIC | Looks up the registered client | Fetches the document from that URL, checks it against a CIMD profile, builds a temporary client for the flow |
| MCP server | Validates the token | Validates the token, the same way |
| Who hosts what | Nothing to host | Someone hosts the JSON document on HTTPS |

So the server change is small. What changes is **which `client_id` values the
server accepts**, and that check doesn't exist yet. Today the server accepts a
token from any client in the realm, as long as the `aud` is right. Adding the
check is part of this work in both modes.

## Constraints found in AIC (Oct 2026)

From [Ping's CIMD page](https://docs.pingidentity.com/pingoneaic/am-oauth2/oauth2-cimd.html)
and from our tenant's discovery document:

- **CIMD is new in AIC** (regular channel 23604.12, 29 Sep 2026, AME-33561).
  It is configured per realm as **CIMD Profiles**.
- **AIC does not advertise CIMD in discovery.** Our tenant's metadata has no
  `client_id_metadata_document_supported`, and Ping's documentation says AIC
  doesn't advertise it yet. MCP clients that follow the spec's priority order
  will not pick CIMD by themselves: they fall back to dynamic registration
  (our tenant has a `registration_endpoint`) or to a configured client ID. For
  now, **each MCP client must be given the document URL as its client ID
  explicitly.** This works with any client that lets you set a client ID,
  because a CIMD client ID is just a string to the client.
- **A profile's URL patterns are the allowlist.** HTTPS only. The path may
  end in `/*`. An explicit port is allowed, a wildcard port is not. If no
  profile matches, or more than one does, AIC returns `invalid_client`.
- **The document must be on the public internet.** It must return `200` over
  HTTPS, be no larger than 5 KB, and have a `client_id` equal to its own URL.
  Redirects are not followed. SSRF protection (on by default) blocks loopback
  and private addresses, so `http://localhost:3000/...` can't host it.
- **The document is not trusted for anything on the profile's deny list.**
  Deny-listed fields always take the profile's value. That is how we pin
  scopes and stop a document from asking for more.
- **Not documented:** what `client_id` claim a CIMD client's access token
  carries, whether the access token modification script runs for CIMD
  clients, consent behaviour, and how long AIC caches a document. Step D3 of
  the test plan checks each of these.

## Server changes

### Configuration (`src/config-schema.ts`, `.env.example`)

| Variable | Mode | Meaning |
| --- | --- | --- |
| `OAUTH_CLIENT_MODE` | both | `public` (default) or `cimd` |
| `OAUTH_ALLOWED_CLIENT_IDS` | `public` | Comma-separated client IDs that may use the server, e.g. `fhir-mcp-public`. Optional, for compatibility with existing `.env` files; if empty, the server logs a startup warning that any client in the realm is accepted |
| `OAUTH_CIMD_CLIENT_ID_PATTERNS` | `cimd` | Comma-separated URL patterns, using the same syntax as the AIC profile. **Required** in `cimd` mode: startup fails without it |

Validation rules, each with a test in `test/config.test.ts`:

- `cimd` without `OAUTH_CIMD_CLIENT_ID_PATTERNS` is a startup error.
- Each pattern must be an absolute `https:` URL with a path. `*` may only
  appear as the final path segment (`/*`). Wildcard hosts and ports are
  rejected.
- In `public` mode, an `https://` value in `OAUTH_ALLOWED_CLIENT_IDS` is
  rejected, with a hint to use `cimd` mode.
- Setting the other mode's variable is an error, so a half-switched `.env`
  doesn't pass silently.

There is no `both` mode. Switching modes means a restart. A transition mode
can be added later if a gradual cut-over is needed.

### Client check (new `src/oauth/client-policy.ts`)

- `isAllowedClient(clientId, policy)` is a pure function:
  - `public`: exact match against the list (or anything, if the list is empty).
  - `cimd`: the `client_id` must parse as an `https:` URL and match a pattern.
    The scheme and host are compared case-insensitively, the path exactly. An
    explicit `:443` is treated as no port, which is the reverse of the
    deliberate exact match on `iss`, because AIC's own pattern matching works
    on URLs.
- `JwtTokenVerifier` calls it after the JWT checks. A disallowed client gets
  the same generic `401 invalid_token` as any other bad token. The log line
  names the reason and the `client_id`; a client ID is not secret.
- `client_id` comes from the `client_id` claim, falling back to `azp`, as it
  does now. Step D3 confirms which claim AIC sets for CIMD clients. If it's
  neither, the claim mapping changes here.

### Elsewhere

- The startup log and `/readyz` report `clientMode`.
- Session binding and audit lines already include `client_id`, so with CIMD
  they show the URL. No change needed.
- Protected Resource Metadata is unchanged: RFC 9728 has no CIMD field, and
  the client finds out about CIMD from the authorization server, not from us.
- The server does **not** host metadata documents. A document describes a
  client, so it belongs with whoever runs the client. Serving it from the MCP
  server would also break locally, because AIC can't reach `localhost`.

### Tests

- `test/client-policy.test.ts`: pattern matching, covering exact URLs, `/*`,
  case, ports, `http:` rejected, look-alike hosts (`evil.example.com.attacker`),
  path traversal and `?query` suffixes.
- `test/oauth.test.ts` (public mode): with `OAUTH_ALLOWED_CLIENT_IDS` set, a
  token from another client gets 401.
- New `test/oauth-cimd.test.ts` (own process, `OAUTH_CLIENT_MODE=cimd`): a
  matching URL `client_id` is accepted. A non-matching URL, `fhir-mcp-public`,
  and a token without `client_id`/`azp` all get 401.

### Documents in the repo

- `cimd/claude-code.json` and `cimd/mcp-inspector.json`: templates with
  `client_id`, `client_name`, `redirect_uris`, `grant_types:
  ["authorization_code"]`, `response_types: ["code"]`,
  `token_endpoint_auth_method: "none"`. The `client_id` is filled in once
  the hosting URL is decided.
- Updates to `docs/aic-setup.md` (the AIC steps below), `docs/oauth-design.md`
  (a decision entry, and remove the limitation "MCP clients use a
  pre-registered public client"), `docs/test-plan.md` (section D below), and
  the config line in `CLAUDE.md`.

## AIC configuration

These go into `docs/aic-setup.md` as a new section. Setting names are quoted
from Ping's documentation. Paths are in the AM native console.

1. **Check the tenant has CIMD.** Open Native Consoles > Access Management >
   Realms > **alpha** > Applications > OAuth 2.0. A **CIMD Profiles** tab
   means the release is installed.
2. **Host the metadata documents** (decision 1 below), and check each one
   from outside your network:
   ```bash
   curl -sS -D - https://<host>/<path>/claude-code.json
   ```
   You should see `200`, no redirect, under 5 KB, and `client_id` equal to
   that exact URL.
3. **Create a CIMD profile** (Add CIMD Profile), for example `fhir-mcp-cimd`:
   | Setting | Value |
   | --- | --- |
   | CIMD Client ID URL Patterns | The hosting prefix, e.g. `https://<host>/<path>/*`. Keep it as narrow as possible: anyone who can publish a file under this prefix becomes a client |
   | CIMD Metadata Override Deny List | `scope`, `grant_types`, `response_types`, `token_endpoint_auth_method`. Add `redirect_uri` too, if you'd rather fix redirect URIs in the profile than trust the document |
   | CIMD SSRF Protection Enabled | `true` (leave the default) |
4. **Set the profile's client defaults** (Core tab):
   - **Scope(s):** `fhir-mcp:read` only. Because `scope` is deny-listed, a
     document can't widen it. This is the least-privilege fix for the
     current, over-broad public client.
   - **Grant types:** authorization code only.
   - **Token endpoint authentication method:** `none` (public client).
5. **PKCE.** On the OAuth2 Provider, set **Code Verifier Parameter Required**
   to require PKCE for at least public clients, if it isn't already. CIMD
   clients using `none` are public clients.
6. **Audience script.** Leave the access token modification script as it is
   (it keys on `resource`, not on the client), but confirm in step D3 that it
   runs for CIMD clients.
7. **Consent.** The consent page shows `client_name`, which comes from the
   document and so can't be trusted. Check that the page also shows the
   client ID URL (or its host). If it doesn't, rely on the narrow URL pattern.
8. **Dynamic registration.** Our realm advertises a `registration_endpoint`.
   Unless something else depends on it, turn off open dynamic client
   registration, so MCP clients can't register their own clients and get
   around the CIMD profile.
9. **After cut-over:** disable `fhir-mcp-public`, or reduce it to
   `fhir-mcp:read` with only the redirect URIs still in use. In the meantime,
   reduce its scopes now, regardless of CIMD.

## Test plan (new section D in test-plan.md)

1. **D1 Document hosting:** the `curl` check in AIC step 2, for each document.
2. **D2 AIC rejects what it should:**
   - a URL outside the pattern gives `invalid_client`
   - a `redirect_uri` that isn't in the document gives an error
   - a document whose `client_id` doesn't match its URL gives an error
3. **D3 Token contents:** do one authorization-code + PKCE flow with the
   document URL as `client_id` (the example flow in Ping's CIMD page, or the
   Inspector). Decode the token (aic-setup.md step 6) and record:
   - `client_id` / `azp`: are they the URL?
   - `aud`: is it the MCP URL, i.e. did the script run?
   - `scope`: is it only `fhir-mcp:read`, even when the client asked for more?
4. **D4 End to end:** run the server with `OAUTH_CLIENT_MODE=cimd` and the
   pattern from AIC step 3. Then connect each client:
   ```bash
   claude mcp add --transport http --client-id https://<host>/<path>/claude-code.json \
     --callback-port 8765 bxhealth-fhir-cimd http://localhost:3000/mcp
   ```
   The Claude Code document must list `http://localhost:8765/callback`. For
   the Inspector, put the document URL in the client ID field; its document
   lists `http://127.0.0.1:6274/oauth/callback`. Run a FHIR search, and check
   that the audit line shows the URL as `client_id`.
5. **D5 Mode isolation:**
   - in `cimd` mode, a `fhir-mcp-public` token gets 401
   - in `public` mode with `OAUTH_ALLOWED_CLIENT_IDS=fhir-mcp-public`, a CIMD
     token gets 401
6. **Regression:** `npm run typecheck`, `npm test`, and section B (public
   mode) still pass.

## Order of work

1. AIC steps 1–4 plus D1–D3, before writing code. D3 settles the claim
   questions, and its answers may change the client check.
2. Config, client policy and tests (server changes above).
3. D4, D5 and the regression run.
4. Documentation updates, then a PR from `PayneUpdate-cimd`.

## Decisions needed

1. **Where to host the documents.** It must be public HTTPS and stable,
   because the URL *is* the client's identity, and changing it means a new
   client. Options:
   - GitHub Pages on a repo you own (quickest for testing)
   - S3 + CloudFront, alongside the planned AWS deployment (recommended for
     anything lasting)
   - the AWS deployment's own domain, as a static path served separately from
     the MCP app

   `origin` is `robpieperping/bxhealth-fhir-mcp`, so Pages on that repo
   depends on its owner.
2. **Whether vendor-hosted client IDs are allowed.** When AIC starts
   advertising CIMD, clients such as Claude Code may present their vendor's
   own document URL, not ours. Allowing them means adding the vendor's URL
   to both the AIC profile and `OAUTH_CIMD_CLIENT_ID_PATTERNS`, which trusts
   the vendor's redirect URIs. The default in this plan is to allow only
   documents we host.

## What CIMD does not fix

CIMD changes **who the client is** and lets us pin the client's scopes. It
doesn't change **what data a user can see**. With `FHIR_AUTH=none`, every
authenticated user can read every patient on the FHIR server. Limiting that
needs the planned token-exchange phase (RFC 8693), so FHIR sees the user, or
patient-level checks in the server. That is a separate piece of work.
