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
  RFC 8707 `resource` request parameter. Configure an **access token
  modification script** on the provider that sets `aud` to the MCP server's
  `MCP_PUBLIC_URL`, for example:

  ```javascript
  // Access token modification script (sketch; check the bindings available
  // in your AIC release). Only for tokens issued to the MCP public client.
  if (accessToken.getClientId() === "fhir-mcp-public") {
    accessToken.setField("aud", ["http://localhost:3000/mcp"]);
  }
  ```

  Use one audience per deployment (the Docker URL while testing locally, the
  AWS URL later), or put both in the array during the transition. Confirm the
  result by decoding a token (step 6).

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
```

Then run through [test-plan.md](test-plan.md), section B.
