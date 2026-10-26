
# Client ID Metadata Documents

## ChatGPT

ChatGPT hosts its own client metadata document. Do not add a local
`cimd/chatgpt.json`: ChatGPT sends an OpenAI-owned URL as `client_id`, either
`https://chatgpt.com/oauth/client.json` or, for callback-specific mode,
`https://chatgpt.com/oauth/<callback_id>/client.json`. The exact document URL
and callback are shown in ChatGPT's MCP server management page. See OpenAI's
[OAuth guide](https://developers.openai.com/plugins/build/auth#oauth-flow).

For ChatGPT to select CIMD automatically, the authorization server's discovery
metadata must advertise `client_id_metadata_document_supported: true`. Rapid
AIC tenants now advertise this capability; confirm it in the target tenant's
discovery document because capabilities can vary by tenant.

**AIC CIMD profile:** on the **CIMD** tab, enter
`https://chatgpt.com/oauth/*` in **CIMD Client ID URL Patterns**. A separate
ChatGPT profile can give this source its own consent name and scope settings.
Keep profile patterns non-overlapping: AIC rejects a URL matching multiple
profiles.

**MCP server configuration:** add the same pattern to the comma-separated
`OAUTH_CIMD_CLIENT_ID_PATTERNS` environment variable so this server accepts
ChatGPT's `client_id`. Keep the existing pattern for your hosted client
documents. For example:

```env
OAUTH_CIMD_CLIENT_ID_PATTERNS=https://<host>/<path>/*,https://chatgpt.com/oauth/*
```

These are two independent allowlists: AIC allows token issuance, while this
MCP setting allows the resulting token's client ID. The Kubernetes
[deployment manifest](../infra/k8s/k8s.yaml) and
[cluster configuration example](../infra/k8s/cluster.env.example) include both
the hosted-document and ChatGPT patterns. Other deployments must opt in.

In the MCP admin console, edit `OAUTH_CIMD_CLIENT_ID_PATTERNS` under
**Settings**, then **Save and restart**. Do not use **Add a document** for
ChatGPT: that creates a document on this server, not an allowlist entry.
Saved admin settings take precedence over deployment environment variables
and persist across redeployments.

On the AIC profile's **Core** tab, allow `openid`, `email`, and `fhir-mcp:read`
in **Scope(s)**. The ChatGPT authorization request observed in testing asks
for all three; allowing only `fhir-mcp:read` causes `Invalid/unknown scopes`.
Keep `scope` on the metadata override deny list so the profile controls the
allowed scopes. The MCP server still requires only `fhir-mcp:read`.

Keep the ChatGPT redirect URIs matched to the exact URI(s) shown in ChatGPT's
MCP server management page. When issuer identification is supported and
returned correctly, the stable callback is
`https://chatgpt.com/connector_platform_oauth_redirect`; otherwise it is
callback-specific, such as
`https://chatgpt.com/connector/oauth/<callback_id>`. Add the
`https://chatgpt.com` origin to the tenant CSP's `form-action` directive.


## Built-in Client Templates

Templates for the MCP clients used with this server in `OAUTH_CLIENT_MODE=cimd`
(see [../docs/cimd-plan.md](../docs/cimd-plan.md) and
[../docs/aic-setup.md](../docs/aic-setup.md#8-cimd-clients)).

The HTTP app serves all five templates at `/cimd/claude-ai.json`, `/cimd/claude-code.json`,
`/cimd/gemini-cli.json`, `/cimd/mcp-inspector.json`, and `/cimd/vscode.json`.
Each response replaces `client_id` with the document path on the origin of
`MCP_PUBLIC_URL`. Only these five documents are exposed, not this directory.
For the Kubernetes deployment, see [the deployment guide](../infra/k8s/README.md).
Local HTTP URLs are useful for checking responses but cannot be fetched by
AIC as CIMD client IDs; use public HTTPS for authentication.

These source templates retain the client IDs previously published at
`https://stephenpayne262.github.io/cimd/`; keep the two in sync. The URL a
document is served from *is* the client's ID, so to host them elsewhere:

1. Set each `client_id` to the exact URL the file will be served from.
2. Publish the files on public HTTPS. AIC must be able to fetch them (no
   localhost or private addresses), with a `200` (no redirects) and at most
   5 KB each.
3. Check what AIC will see:
   ```bash
   url=https://<host>/<path>/claude-code.json
   curl -sS -o /dev/null -w '%{http_code} %{size_download} bytes %{redirect_url}\n' "$url"
   curl -sS "$url" | jq -e --arg u "$url" '.client_id == $u'
   ```

The redirect URIs must match what each client sends exactly:
Claude Code with `--callback-port 8765`, Gemini CLI with `redirectUri` set
to port 7777 (it uses a random port otherwise), and the MCP Inspector on port
6274 (the browser may use `127.0.0.1` or `localhost`, so both are listed).
Each callback origin must also be in the tenant CSP's `form-action`
([aic-setup.md](../docs/aic-setup.md#8-cimd-clients), step 10). `scope` and
`grant_types` here are informational: the AIC profile deny-lists them and
always applies its own.

## Gemini CLI

Add the server to `~/.gemini/settings.json`, then run `/mcp auth bxhealth-fhir`
inside `gemini`:

```json
{
  "mcpServers": {
    "bxhealth-fhir": {
      "httpUrl": "http://localhost:3000/mcp",
      "oauth": {
        "enabled": true,
        "clientId": "https://stephenpayne262.github.io/cimd/gemini-cli.json",
        "redirectUri": "http://localhost:7777/oauth/callback",
        "scopes": ["fhir-mcp:read"]
      }
    }
  }
}
```

Tokens are stored in `~/.gemini/mcp-oauth-tokens.json`; delete the entry to
force a new login.

## Visual Studio Code

Use the document URL as the client ID and leave the client secret blank.
VS Code may attempt DCR first; its **Copy URIs & Proceed** dialog allows
manual client ID entry if automatic CIMD discovery is not used.
The template's `http://127.0.0.1/` redirect is not verified against AIC's
matching rules. Before login, compare the actual VS Code callback (including
port and path) with the document and any profile overrides. Do not assume
that a portless loopback URI permits every port in AIC.

`redirect_uris` is a JSON array of URI strings, not a comma- or
space-delimited string. For a VS Code callback such as
`http://127.0.0.1:33418/`, the stable loopback URI is
`http://127.0.0.1/`; the client chooses a new port on each login. Do not put
one observed ephemeral port in the document or use a wildcard port. RFC 8252
recommends authorization servers allow any port for loopback IP redirect
URIs, but verify that AIC honors this for your CIMD profile. If your profile
pins `redirect_uri` using the metadata override denylist, configure and test
that profile value as well.

If VS Code sends `client_id=https://vscode.dev/oauth/client-metadata.json`,
AIC fetches that VS Code-hosted document; it does not use this project's
`cimd/vscode.json`. To use this project's document instead, configure VS Code
with the deployed `/cimd/vscode.json` URL. Ensure both the AIC CIMD profile
and the server's `OAUTH_CIMD_CLIENT_ID_PATTERNS` allow whichever client ID
you choose.
