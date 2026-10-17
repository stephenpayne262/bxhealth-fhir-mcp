# Client ID Metadata Documents

Templates for the MCP clients used with this server in `OAUTH_CLIENT_MODE=cimd`
(see [../docs/cimd-plan.md](../docs/cimd-plan.md) and
[../docs/aic-setup.md](../docs/aic-setup.md#8-cimd-clients)).

The URL a document is served from *is* the client's ID, so:

1. Replace `https://CIMD_HOST/CIMD_PATH/` in each `client_id` with the exact
   URL the file will be served from.
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
Claude Code with `--callback-port 8765`, and the MCP Inspector on port 6274
(the browser may use `127.0.0.1` or `localhost`, so both are listed). The
`scope` here is informational: the AIC profile deny-lists `scope` and
always grants its own.
