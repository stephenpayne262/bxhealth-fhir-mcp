# Client ID Metadata Documents

Templates for the MCP clients used with this server in `OAUTH_CLIENT_MODE=cimd`
(see [../docs/cimd-plan.md](../docs/cimd-plan.md) and
[../docs/aic-setup.md](../docs/aic-setup.md#8-cimd-clients)).

These files are the copies published at
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
