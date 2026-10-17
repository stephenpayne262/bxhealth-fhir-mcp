/**
 * Which OAuth clients may call this server, judged by the token's `client_id`
 * (or `azp`). The authorization server decides who can get a token; this is
 * the resource server's own check that the token came from a client it
 * expects, so another client in the same realm with the right audience is
 * still refused.
 *
 * - `public`: pre-registered client IDs, matched exactly. An empty list
 *   accepts any client (the phase 1 behaviour; the server warns at startup).
 * - `cimd`: the client ID is the HTTPS URL of a Client ID Metadata Document
 *   and must match one of the patterns, using the same syntax as an AIC CIMD
 *   profile's "CIMD Client ID URL Patterns": an exact URL, or a prefix ending
 *   in `/*`. Hosts and ports are never wildcards.
 *
 * Pure (no I/O), so config-schema.ts can validate patterns at startup.
 */

export type ClientPolicy =
  | { mode: "public"; allowedClientIds: string[] }
  | { mode: "cimd"; patterns: string[] };

/** Returns a reason the pattern is invalid, or null if it is usable. */
export function patternProblem(pattern: string): string | null {
  let url: URL;
  try {
    url = new URL(pattern);
  } catch {
    return "must be an absolute URL (a wildcard port is not allowed)";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.username || url.password) return "must not contain credentials";
  if (url.search || url.hash) return "must not contain a ?query or #fragment";
  if (url.hostname.includes("*")) return "must not use a wildcard host";
  if (url.pathname === "/") return "must include a path, or end in /* to allow every path on the host";
  const stars = url.pathname.split("*").length - 1;
  if (stars > 1 || (stars === 1 && !url.pathname.endsWith("/*"))) {
    return "may use * only as the final path segment (/*)";
  }
  return null;
}

/**
 * A CIMD client ID is accepted only in canonical form (lowercase host, no
 * default port, no dot segments or encoded dots, no query or fragment), so
 * the string compared here is the string the authorization server fetched.
 */
function canonicalCimdUrl(clientId: string): URL | null {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.href !== clientId) return null;
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname === "/") return null;
  return url;
}

function matchesPattern(url: URL, pattern: string): boolean {
  const p = new URL(pattern);
  if (url.origin !== p.origin) return false;
  if (!p.pathname.endsWith("/*")) return url.pathname === p.pathname;
  const prefix = p.pathname.slice(0, -1); // keep the trailing slash
  return url.pathname.startsWith(prefix) && url.pathname.length > prefix.length;
}

/** Returns null if the client is allowed, otherwise the reason it is not. */
export function clientRejection(clientId: string | undefined, policy: ClientPolicy): string | null {
  if (policy.mode === "public") {
    if (policy.allowedClientIds.length === 0) return null;
    if (clientId && policy.allowedClientIds.includes(clientId)) return null;
    return "client_id is not in OAUTH_ALLOWED_CLIENT_IDS";
  }
  if (!clientId) return "token has no client_id or azp";
  const url = canonicalCimdUrl(clientId);
  if (!url) return "client_id is not a canonical https metadata document URL";
  if (policy.patterns.some((pattern) => matchesPattern(url, pattern))) return null;
  return "client_id does not match OAUTH_CIMD_CLIENT_ID_PATTERNS";
}
