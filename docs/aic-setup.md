# Authorization server setup: PingOne Advanced Identity Cloud

This sets up a PingOne Advanced Identity Cloud (AIC) tenant to issue access
tokens this MCP server accepts. It uses your own tenant and realm; nothing here
depends on any other environment.

What the server requires of a token (see [oauth-design.md](oauth-design.md)):

| Claim / property | Must be |
| --- | --- |
| Format | A signed JWT (not an opaque token), RS256 or ES256 |
| `iss` | Exactly `OAUTH_ISSUER` |
| `aud` | `MCP_PUBLIC_URL` (or contain it, if an array) |
| `scope` | Includes `fhir-mcp:read` (or whatever `OAUTH_REQUIRED_SCOPES` lists) |
| `sub`, `exp` | Present |

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
Our tenant is openam-scp-bx26 and our realm is /alpha

https://openam-scp-bx26.forgeblocks.com/am/oauth2/realms/root/realms/alpha/.well-known/openid-configuration

  "issuer": "https://openam-scp-bx26.forgeblocks.com:443/am/oauth2/realms/root/realms/alpha",

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
- **Audience.** By default AM sets `aud` to the client ID, and it ignores the
  RFC 8707 `resource` request parameter. Ping's MCP guidance is an **access
  token modification script** that copies the requested `resource` into the
  token (Scripts > New Script > OAuth2 Access Token Modification, then select
  it on the OAuth2 Provider's Plugins tab). Ping's sample writes a claim named
  `audience`, which leaves `aud` unchanged; this server checks `aud`, so write
  `aud`, and only for resources you list:

  ```javascript
  (function () {
    var allowed = ["http://localhost:3000/mcp"];
    var params = requestProperties.get("requestParams");
    var resource = params && params.get("resource");
    if (resource && resource.size() > 0 && allowed.indexOf(String(resource.get(0))) !== -1) {
      accessToken.setField("aud", String(resource.get(0)));
    }
  }());
  ```

  Add each deployment's `MCP_PUBLIC_URL` to `allowed` (the Docker URL while
  testing locally, the AWS URL later). Confirm the result by decoding a token
  (step 6). If the server rejects a token for its audience, its log line shows
  the `aud` (and any `audience`) the token carried.

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
- **Claude Code:** a loopback callback on `localhost`. AM matches redirect
  URIs exactly, so if your Claude Code version picks a random port, use its
  option to fix the callback port and register that URI. See
  `claude mcp add --help`.

## 5. Test users

Create two users:

- one who can be granted `fhir-mcp:read` (the happy path), and
- one who cannot, or a second client without the scope, to verify the `403
  insufficient_scope` response.

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
- [ ] **Redirect URIs** for each MCP client work (no `redirect_uri_mismatch`).
- [ ] **PKCE** is enforced: an authorization request without
  `code_challenge` is refused.

Decode a token locally without sending it anywhere:

```bash
TOKEN=...   # from the Inspector
cut -d. -f2 <<<"$TOKEN" | tr '_-' '/+' | base64 -d 2>/dev/null | jq '{iss, aud, sub, scope, client_id, exp}'
```

Do not paste production tokens into online JWT decoders.

## 7. Configure the MCP server

```bash
MCP_PUBLIC_URL=http://localhost:3000/mcp
OAUTH_ISSUER=https://<tenant>.forgeblocks.com:443/am/oauth2/realms/root/realms/<realm>
OAUTH_REQUIRED_SCOPES=fhir-mcp:read
OAUTH_CLIENT_MODE=public
OAUTH_ALLOWED_CLIENT_IDS=fhir-mcp-public
```

Then run through [test-plan.md](test-plan.md), section B.

## 8. CIMD clients

With Client ID Metadata Documents (CIMD), an MCP client's ID is the HTTPS URL
of a JSON document describing it, and nobody pre-registers it in AIC. AIC
fetches the document during login and builds a temporary client from it plus
a **CIMD profile**. Background and design: [cimd-plan.md](cimd-plan.md).

AIC added CIMD in the 29 Sep 2026 release ([Ping's CIMD
page](https://docs.pingidentity.com/pingoneaic/am-oauth2/oauth2-cimd.html)).
It does **not** advertise it in discovery yet (no
`client_id_metadata_document_supported`), so MCP clients won't choose CIMD by
themselves: give each one the document URL as its client ID.

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
   | CIMD Client ID URL Patterns | Where the documents are hosted, as narrowly as possible, e.g. `https://<host>/<path>/*`. Anyone who can publish a file under this prefix becomes a client |
   | CIMD Metadata Override Deny List | `scope`, `grant_types`, `response_types`, `token_endpoint_auth_method`, `client_name` (step 7). Add `redirect_uri` to pin redirect URIs in the profile instead of trusting the document |
   | CIMD SSRF Protection Enabled | `true` (the default) |

   If no profile matches a client ID, or more than one does, AIC returns
   `invalid_client`.
4. **Set the profile's client defaults** (Core tab): **Scope(s)**
   `fhir-mcp:read` only, authorization code grant only, token endpoint
   authentication method `none`. With `scope` deny-listed, a document can't
   ask for more.
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
   `client_id`, `azp`, `aud` and `scope`. The server takes the client from
   `client_id`, falling back to `azp`, and needs it to be the document URL.

Then configure the server and connect a client:

```bash
OAUTH_CLIENT_MODE=cimd
OAUTH_CIMD_CLIENT_ID_PATTERNS=https://<host>/<path>/*   # same as the profile
# and remove OAUTH_ALLOWED_CLIENT_IDS
```

```bash
claude mcp add --transport http --client-id https://<host>/<path>/claude-code.json \
  --callback-port 8765 bxhealth-fhir-cimd http://localhost:3000/mcp
```

For the MCP Inspector, put `https://<host>/<path>/mcp-inspector.json` in the
client ID field. For Gemini CLI, use `https://<host>/<path>/gemini-cli.json`
as `oauth.clientId` (settings in [`cimd/README.md`](../cimd/README.md#gemini-cli)). Then run [test-plan.md](test-plan.md), section D. After the
cut-over, disable `fhir-mcp-public`, or at least reduce it to
`fhir-mcp:read` and the redirect URIs still in use.
