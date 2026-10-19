# Client ID Metadata Documents (CIMD) with PingOne AIC

Decision record. The setup steps are in [aic-setup.md](aic-setup.md),
section 8; the tests in [test-plan.md](test-plan.md), section D; the
document templates in [`cimd/`](../cimd/README.md).

Status (Oct 2026): built and working end to end with Claude Code against
the `uhgc` tenant. The rest of test-plan.md section D is still to run.

## Goal

Let MCP clients identify themselves to AIC with a Client ID Metadata
Document, instead of a client someone pre-registered in AIC, and switch the
server between the two models with one setting:

```bash
OAUTH_CLIENT_MODE=public   # pre-registered client IDs (OAUTH_ALLOWED_CLIENT_IDS)
OAUTH_CLIENT_MODE=cimd     # client IDs are HTTPS URLs of documents (OAUTH_CIMD_CLIENT_ID_PATTERNS)
```

## Who does what

CIMD is an agreement between the **MCP client** and **AIC**. The MCP server is
the resource server and never sees the document.

| Party | Public client | CIMD |
| --- | --- | --- |
| MCP client | Sends `client_id=fhir-mcp-public` | Sends `client_id=https://…/claude-code.json` |
| AIC | Looks up the registered client | Fetches the document, checks it against a CIMD profile, builds a temporary client for the flow |
| MCP server | Validates the token and checks `client_id` against `OAUTH_ALLOWED_CLIENT_IDS` | Validates the token and checks `client_id` against `OAUTH_CIMD_CLIENT_ID_PATTERNS` (`src/oauth/client-policy.ts`) |
| Hosting | Nothing | The JSON documents, on public HTTPS |

## What we found in AIC

- **CIMD is new** (regular channel 23604.12, 29 Sep 2026, AME-33561) and is
  configured per realm as **CIMD Profiles**
  ([Ping's CIMD page](https://docs.pingidentity.com/pingoneaic/am-oauth2/oauth2-cimd.html)).
- **It isn't advertised in discovery** (no
  `client_id_metadata_document_supported`), so clients won't pick CIMD by
  themselves. Each one is given the document URL as its client ID.
- **The profile's URL patterns are the allowlist:** HTTPS, an optional
  trailing `/*`, an explicit port but no wildcard port. No match, or more
  than one, gives `invalid_client`.
- **Documents must be public:** `200` over HTTPS with no redirects, at most
  5 KB, `client_id` equal to the URL. SSRF protection blocks loopback and
  private addresses.
- **Deny-listed fields always take the profile's value.** That is how scopes,
  grant types and the consent name are pinned.
- **Answered by testing:** the token's `client_id` is the document URL, the
  access token modification script runs for CIMD clients (so `aud` and
  `patient` are set), and the consent page shows the profile's fixed name.
  Not yet known: how long AIC caches a document.
- **The tenant CSP must allow the local callback.** Otherwise AIC returns the
  redirect with a code, but the browser blocks it and stays on the consent
  page (aic-setup.md, section 8, step 10).

## Decisions

1. **The server checks the client in both modes.** Before this work, any
   client in the realm with the right `aud` was accepted. A refused client
   gets the same generic `401` as any bad token; the log says why.
2. **No `both` mode.** Switching modes is a restart, and setting the other
   mode's variable is a startup error, so a half-switched `.env` fails
   loudly. A transition mode can be added if a gradual cut-over is needed.
3. **Only canonical client ID URLs match** (`new URL(id).href === id`), so the
   string the server checks is the one AIC fetched.
4. **The server doesn't host documents.** A document describes a client, so
   it belongs with whoever runs the client, and AIC couldn't reach a
   `localhost` server anyway.
5. **Hosting:** GitHub Pages (`https://stephenpayne262.github.io/cimd/`) for
   testing. The URL *is* the client's identity, so anything lasting should
   move to a stable host, such as S3 and CloudFront next to the AWS
   deployment; moving means new client IDs.
6. **Only documents we host are allowed.** Accepting a vendor's own document
   URL (once AIC advertises CIMD) would mean trusting the vendor's redirect
   URIs, and needs adding to both the AIC profile and
   `OAUTH_CIMD_CLIENT_ID_PATTERNS`.

## What CIMD does not fix

CIMD changes **who the client is** and pins the client's scopes. It doesn't
change **what data a user can see**. Patient scoping does that
(`MCP_PATIENT_SCOPED`, `src/patient-scope.ts`): the token's `patient` claim
comes from the member's AIC identity, not from the document, and the server
limits every tool call to that patient.
