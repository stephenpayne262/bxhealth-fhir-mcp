# Authorization server setup: PingOne Advanced Identity Cloud

This sets up a PingOne Advanced Identity Cloud (AIC) tenant for this MCP
server. The tenant plays two roles:

- **Inbound:** it issues the access tokens MCP clients present to this
  server, on behalf of a signed-in member (sections 2-8).
- **Outbound:** it issues the server's own system-level token for the FHIR
  agent endpoint, by client credentials (section 9).

It uses your own tenant and realm; nothing here depends on any other
environment.

What the server requires of a token (see [oauth-design.md](oauth-design.md)):

| Claim / property | Must be |
| --- | --- |
| Format | A signed JWT (not an opaque token), RS256 or ES256 |
| `iss` | Exactly `OAUTH_ISSUER` |
| `aud` | `MCP_PUBLIC_URL` (or contain it, if an array) |
| `scope` | Includes `fhir-mcp:read` (or whatever `OAUTH_REQUIRED_SCOPES` lists) |
| `sub`, `exp` | Present |
| `patient` | The member's FHIR Patient id (`123`, `Patient/123` or an absolute `.../Patient/123`). Required while `MCP_PATIENT_SCOPED=true`, the default; the claim name is `OAUTH_PATIENT_CLAIM`. A token without it gets `403` |

AIC's admin UI changes between releases, so the steps below name the settings
rather than exact menu paths. Most of them live in the AM native console of
the realm (OAuth2 Provider service, and OAuth 2.0 clients).

## 1. Realm and issuer

Use a realm in your tenant (`alpha` or a new one). Fetch its discovery
document and note the `issuer` value exactly:

```bash
curl -s https://<tenant>.forgeblocks.com/am/oauth2/realms/root/realms/<realm>/.well-known/openid-configuration \
  | jq '{issuer, jwks_uri, authorization_endpoint, token_endpoint, code_challenge_methods_supported}'
```
For example, the `uhgc` tenant's `alpha` realm reports
`"issuer": "https://openam-uhgc.forgeblocks.com:443/am/oauth2/realms/root/realms/alpha"`
and `"token_endpoint": "https://openam-uhgc.forgeblocks.com:443/am/oauth2/realms/root/realms/alpha/access_token"`.

AM reports the issuer with an explicit `:443`
(`https://<tenant>.forgeblocks.com:443/am/oauth2/realms/root/realms/<realm>`).
Set `OAUTH_ISSUER` to that string **including the port**: the server compares
it byte for byte with the token's `iss` and with the discovery document.
`code_challenge_methods_supported` should include `S256`.

## 2. Scope

Create or allow the scope `fhir-mcp:read`. It does not have to appear in the
realm's `scopes_supported` for tokens to carry it, but it must be allowed on
the client below.

## 3. OAuth2 Provider (realm service)

- **JWT access tokens.** Enable client-based (stateless) access tokens so
  tokens are signed JWTs the server can verify against the JWKS. Opaque
  tokens are rejected.
- **Signing algorithm.** RS256 or ES256, matching `OAUTH_ALGORITHMS`.
- **Lifetime.** 15 to 60 minutes. The server validates tokens statelessly, so
  a revoked token stays usable until it expires; short lifetimes limit that.
- **Audience and patient claim.** Both come from an **access token
  modification script** (Scripts > New Script > OAuth2 Access Token
  Modification, then select it on the OAuth2 Provider's Plugins tab).
  - *Audience:* by default AM sets `aud` to the client ID, and it ignores the
    RFC 8707 `resource` request parameter. Ping's MCP guidance is to copy the
    requested `resource` into the token. Ping's sample writes a claim named
    `audience`, which leaves `aud` unchanged; this server checks `aud`, so
    write `aud`, and only for resources you list.
  - *Patient:* put the member's FHIR Patient id in a `patient` claim. The
    server takes the member's identity from this claim alone, so its source
    must be one members can't change themselves.

  The script this deployment uses is
  [aic-access-token-modification.js](aic-access-token-modification.js). It
  also carries the SMART launch context for the patient-facing FHIR apps.
  For MCP clients it:

  - sets `aud` to the requested `resource` when it is in `allowedResources`.
    Add each deployment's `MCP_PUBLIC_URL` there.
  - sets `patient` from the `fhirid` property the login journey puts on the
    session, falling back to the identity's `fr-attr-istr1`. Only the journey
    should ever set `fhirid`, and only to the member's own id, because this
    server trusts the claim completely. For the same reason, check that
    members can't edit `fr-attr-istr1` (the user schema property
    `frIndexedString1`): it must not be marked user editable, and no
    end-user journey or account page may set it.
  - **ties MCP tokens to the member's AIC session.** A refresh for an MCP
    resource without a live session has no `fhirid`, so the script refuses
    it (`KillRefreshTokenNow`), and the client signs in again instead of
    getting a token this server would answer with `403`. If AM never passes
    a session on refresh, MCP refreshes always fail and members sign in
    again when the access token expires. That is safe, just less convenient.

  Test both paths after installing it:
  1. Refresh while signed in to AIC: calls keep working.
  2. Sign out of AIC in the browser, then wait for the access token to
     expire: the refresh is refused, and the client asks you to sign in
     again. It never gets a `403` from this server.

  If the tenant already adds `patient` for another app, such as the
  patient-facing FHIR app, make sure the script that runs for **this
  server's clients** sets it as well. The OAuth2 Provider takes one access
  token modification script, and a client's OAuth2 Provider Overrides can
  replace it for that client. Whichever script the MCP clients get must set
  both `aud` and `patient`. Decode a token to be sure (step 6).

  If the server rejects a token for its audience, its log line shows the
  `aud` (and any `audience`) the token carried.

  **Fallback if the audience cannot be changed:** set
  `OAUTH_AUDIENCE=fhir-mcp-public` (the client ID). Any token issued to that
  client is then accepted, which is acceptable only while the client exists
  solely for this server. Treat it as a temporary workaround.

## 4. Public OAuth client for MCP clients

Create an OAuth 2.0 client, for example `fhir-mcp-public`:

| Setting | Value |
| --- | --- |
| Client type | Public (no client secret) |
| Token endpoint authentication method | `none` |
| Grant types | Authorization Code only |
| PKCE | Required, `S256` |
| Scopes | `openid fhir-mcp:read` |
| Redirect URIs | One per MCP client you test with (below) |

Redirect URIs:

- **MCP Inspector:** `http://localhost:6274/oauth/callback` (and
  `http://localhost:6274/oauth/callback/debug` for its debug flow).
- **Claude Code:** `http://localhost:8765/callback`, with
  `claude mcp add ... --callback-port 8765`. Without that option Claude Code
  picks a random port, which AM's exact redirect URI match refuses.

Each callback origin must also be allowed by the tenant's Content Security
Policy (section 8, step 10).

## 5. Test users

Create, or reuse, members whose patient attribute holds a FHIR Patient id
that exists on the FHIR server:

- **Two members with different patients.** Each should see only their own
  data, and be refused when asking for the other's.
- **One member without the patient attribute.** Their connection should get
  a `403`, and the server logs `no usable "patient" claim`.
- **One user who can't be granted `fhir-mcp:read`**, or a second client
  without the scope, to check the `403 insufficient_scope` response.

## 6. Verify before connecting the MCP server (step 0 checklist)

These are the things that cost the most time if discovered late. Check each
one with the tenant alone:

- [ ] **Discovery** answers at `<issuer>/.well-known/openid-configuration`, and
  its `issuer` is the exact string in `OAUTH_ISSUER`.
- [ ] **Which discovery URL the MCP clients request.** AM serves the OpenID
  form above. Some clients only try the RFC 8414 form
  (`https://<tenant>/.well-known/oauth-authorization-server/am/oauth2/...`),
  which AM does not serve. Watch the Inspector's auth debug view or network
  log during the first login.
- [ ] **Tokens are JWTs.** Get a token through the Inspector's OAuth flow and
  decode it (three dot-separated parts; the header has `alg` and `kid`).
- [ ] **`iss`** in the token equals `OAUTH_ISSUER` exactly.
- [ ] **`aud`** in the token equals `MCP_PUBLIC_URL` (or contains it).
- [ ] **`scope`** contains `fhir-mcp:read`.
- [ ] **`patient`** holds the member's FHIR Patient id, and the id exists on
  the FHIR server.
- [ ] **Redirect URIs** for each MCP client work (no `redirect_uri_mismatch`).
- [ ] **PKCE** is enforced: an authorization request without
  `code_challenge` is refused.

Decode a token locally without sending it anywhere:

```bash
TOKEN=...   # from the Inspector
cut -d. -f2 <<<"$TOKEN" | tr '_-' '/+' | base64 -d 2>/dev/null | jq '{iss, aud, sub, scope, client_id, patient, exp}'
```

MCP clients such as Claude Code don't show the token they hold. To check the
claim from inside a session instead, ask for the member's own Patient record
(a Patient search with no parameters). The server pins it to the claim's id,
and the response's `self` link shows `_id=<that id>`.

Do not paste production tokens into online JWT decoders.

## 7. Configure the MCP server

In `.env` (see [`.env.example`](../.env.example) for every variable):

```bash
MCP_PUBLIC_URL=http://localhost:3000/mcp
OAUTH_ISSUER=https://<tenant>.forgeblocks.com:443/am/oauth2/realms/root/realms/<realm>
OAUTH_REQUIRED_SCOPES=fhir-mcp:read
OAUTH_CLIENT_MODE=public
OAUTH_ALLOWED_CLIENT_IDS=fhir-mcp-public
# Patient scoping is on by default; only set these to change them.
# MCP_PATIENT_SCOPED=true
# OAUTH_PATIENT_CLAIM=patient
```

For CIMD clients, use the client settings in section 8 instead. For the
outbound FHIR token, add the settings in section 9. Then start the server
in Docker and check it:

```bash
docker compose up -d --force-recreate
curl -s localhost:3000/readyz   # oauth.state "ready" for this issuer
```

Then run through [test-plan.md](test-plan.md), section B.

## 8. CIMD clients

With Client ID Metadata Documents (CIMD), an MCP client's ID is the HTTPS URL
of a JSON document describing it, and nobody pre-registers it in AIC. AIC
fetches the document during login and builds a temporary client from it plus
a **CIMD profile**. Background and design: [cimd-plan.md](cimd-plan.md).

AIC added CIMD in the 29 Sep 2026 release ([Ping's CIMD
page](https://docs.pingidentity.com/pingoneaic/am-oauth2/oauth2-cimd.html)).
Rapid tenants now advertise CIMD support in discovery with
`client_id_metadata_document_supported: true`, allowing compatible clients
such as ChatGPT to select CIMD automatically. Confirm the flag is present in
the target tenant's discovery document; tenant capabilities can vary. For
clients that do not select CIMD automatically, configure the client ID
explicitly. See the ChatGPT notes in [`cimd/README.md`](../cimd/README.md#chatgpt).

1. **Check the release is installed.** In the native console: Realms >
   *realm* > Applications > OAuth 2.0 should have a **CIMD Profiles** tab.
2. **Publish the documents.** Fill in and host the templates in
   [`cimd/`](../cimd/README.md), then run the `curl` check there. Each must
   be on public HTTPS (SSRF protection blocks loopback and private
   addresses), return `200` without redirects, be at most 5 KB, and have a
   `client_id` equal to its own URL.
3. **Create a CIMD profile** (Add CIMD Profile), e.g. `fhir-mcp-cimd`:

   | Setting | Value |
   | --- | --- |
  | CIMD Client ID URL Patterns | Where the documents are hosted, as narrowly as possible, e.g. `https://<host>/<path>/*`. Anyone who can publish a file under this prefix becomes a client. For ChatGPT, add `https://chatgpt.com/oauth/*` only when enabling ChatGPT CIMD |
   | CIMD Metadata Override Deny List | `scope`, `grant_types`, `response_types`, `token_endpoint_auth_method`, `client_name` (step 7). Add `redirect_uri` to pin redirect URIs in the profile instead of trusting the document |
   | CIMD SSRF Protection Enabled | `true` (the default) |

   If no profile matches a client ID, or more than one does, AIC returns
   `invalid_client`.
4. **Set the profile's client defaults** (Core tab): **Scope(s)**
   `fhir-mcp:read` only, grant types authorization code and refresh token
   (the token script limits refreshes to a live session; leave refresh token
   out to make members sign in again whenever a token expires), token
   endpoint authentication method `none`. With `scope` deny-listed, a document can't
   ask for more.
   For a ChatGPT-specific profile, allow `openid`, `email`, and `fhir-mcp:read`:
   the observed ChatGPT authorization request includes all three. Omitting a
   requested scope causes `Invalid/unknown scopes`, even if the default scopes
   include `fhir-mcp:read`. Keep `scope` deny-listed; this pins the allowed
   scopes, not the scopes a client requests in the authorization URL.
5. **PKCE.** On the OAuth2 Provider, make sure **Code Verifier Parameter
   Required** covers public clients. CIMD clients using `none` are public.
6. **Audience script.** No change: the script in step 3 keys on the
   requested `resource`, not on the client. Confirm it runs for CIMD clients
   by decoding a token (below).
7. **Consent.** By default the consent page shows `client_name` from the
   document, which anyone who can publish under your pattern controls. Add
   `client_name` to the profile's **CIMD Metadata Override Deny List** and set
   a fixed name on the profile (e.g. `bxhealth FHIR MCP (CIMD)`), so the
   consent page always shows your name. Leave **Allow Clients to Skip
   Consent** off on the OAuth2 Provider's Consent tab. During the first CIMD
   login, check what the consent page actually shows (test D3).
8. **Dynamic registration.** The realm advertises a `registration_endpoint`.
   Unless something depends on it, turn off open dynamic client
   registration, so clients can't register their way around the profile.
9. **Check one token** (as in step 6) from a CIMD login and record
   `client_id`, `azp`, `aud`, `scope` and `patient`. The server takes the client from
   `client_id`, falling back to `azp`, and needs it to be the document URL.
10. **Content Security Policy.** The hosted login pages send a CSP whose
    `form-action` directive also applies to the redirect after the consent
    form is submitted. Add the origin of every local callback to the
    tenant's CSP `form-action`: `http://localhost:8765` (Claude Code),
      `http://localhost:6274` and `http://127.0.0.1:6274` (MCP Inspector),
      `http://localhost:7777` (Gemini CLI), and `https://chatgpt.com` when
      enabling ChatGPT. Use the exact ChatGPT callback URI shown in its
      management page; callback mode depends on issuer identification support.
      In the admin console, go to
    **Tenant Settings > Global Settings > Content Security Policy >
    Enforced Policy**, edit `form-action`, add the origins (no path), save,
    then click **Publish**. Changes take a few minutes. The policy covers
    both realms, so add sources without removing any.

    If an origin is missing, AIC still returns a 302 to the callback with a
    valid `code`, but the browser refuses to follow it: the consent page
    stays on screen after **Allow**, and the browser console shows a
    `form-action` CSP violation. This applies to the public client in
    section 4 too.

Then configure the server and connect a client:

```bash
OAUTH_CLIENT_MODE=cimd
# Append ,https://chatgpt.com/oauth/* to this and the AIC profile when enabled.
OAUTH_CIMD_CLIENT_ID_PATTERNS=https://<host>/<path>/*   # same as the profile
# and remove OAUTH_ALLOWED_CLIENT_IDS
```

The server's patterns and AIC's profile patterns are independent checks.
The Kubernetes manifest includes the hosted-document and ChatGPT patterns;
other deployments must add ChatGPT explicitly. In the MCP admin console,
change the pattern list under **Settings**, not **CIMD client documents**,
then **Save and restart**. Admin overrides persist and take precedence over
environment settings. See the [ChatGPT setup notes](../cimd/README.md#chatgpt).

```bash
claude mcp add --transport http --client-id https://<host>/<path>/claude-code.json \
  --callback-port 8765 bxhealth-fhir-cimd http://localhost:3000/mcp
```

For the MCP Inspector, put `https://<host>/<path>/mcp-inspector.json` in the
client ID field. For Gemini CLI, use `https://<host>/<path>/gemini-cli.json`
as `oauth.clientId` (settings in [`cimd/README.md`](../cimd/README.md#gemini-cli)). Then run [test-plan.md](test-plan.md), section D. After the
cut-over, disable `fhir-mcp-public`, or at least reduce it to
`fhir-mcp:read` and the redirect URIs still in use.

## 9. Client for the FHIR agent endpoint

This server calls FHIR with its own token, never the member's (the MCP spec
forbids passing the caller's token through). Smile CDR's agent endpoint
(`/fhir-agent`) accepts only basic auth or a system-scoped client
credentials token, so that token can read every patient. Patient scoping in
this server (`MCP_PATIENT_SCOPED`, `src/patient-scope.ts`) is what keeps
each member to their own records.

1. **Create a confidential OAuth 2.0 client**, e.g. `fhir-mcp-agent`:

   | Setting | Value |
   | --- | --- |
   | Client type | Confidential, with a client secret |
   | Grant types | Client Credentials only |
   | Token endpoint authentication method | `client_secret_basic` (the server's default), or `client_secret_post` with `FHIR_TOKEN_AUTH_METHOD=client_secret_post` |
   | Scopes | The system scope the agent endpoint requires, e.g. `system/*.read`, and nothing else |
   | Redirect URIs | None |

   Read-only scopes are enough: patient scoping requires
   `MCP_READ_ONLY=true`.
2. **Make Smile CDR trust it.** The agent endpoint must accept tokens from
   this issuer and map this client's system scope to read access. That is
   configured in Smile CDR, not AIC.
3. **Check the token.** Request one directly and decode it as in step 6.
   It should have this client's `client_id`, the system scope, and no
   `patient` claim:

   ```bash
   curl -s -u "fhir-mcp-agent:$SECRET" -d grant_type=client_credentials -d 'scope=system/*.read' \
     https://<tenant>.forgeblocks.com:443/am/oauth2/realms/root/realms/<realm>/access_token | jq -r .access_token
   ```
4. **Configure the server:**

   ```bash
   FHIR_BASE_URL=https://<smile-host>/fhir-agent
   FHIR_AUTH=client_credentials
   FHIR_TOKEN_URL=https://<tenant>.forgeblocks.com:443/am/oauth2/realms/root/realms/<realm>/access_token
   FHIR_CLIENT_ID=fhir-mcp-agent
   FHIR_CLIENT_SECRET=...
   FHIR_SCOPE=system/*.read
   ```

   After `docker compose up -d --force-recreate`, `/readyz` fetches the
   FHIR CapabilityStatement with this token, so `fhir.versionMatches: true`
   shows that the grant and the endpoint both work. If the token can't be
   fetched, the server log has a `[fhir-auth]` line with AIC's error.
