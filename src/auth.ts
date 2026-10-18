import axios from "axios";
import { config } from "./config.js";

/**
 * Outbound credentials for calls from this server to FHIR (FHIR_AUTH).
 *
 * This is the server's own identity, not the MCP caller's: the caller's
 * token is never forwarded to FHIR (the MCP spec forbids token passthrough).
 * Delegated access is a later phase, via token exchange.
 */

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
// Shared by concurrent callers so a cold or expiring cache triggers one
// token request, not one per in-flight tool call.
let pendingToken: Promise<string> | null = null;

/**
 * Returns the bearer token to send to FHIR, or null when FHIR_AUTH=none.
 *
 * With FHIR_AUTH=client_credentials, runs an OAuth client_credentials grant
 * against FHIR_TOKEN_URL (any OAuth 2.0 token endpoint, e.g. PingOne AIC's
 * .../access_token), caches the token, and refreshes it 30 seconds before
 * expiry. If no token can be obtained this throws: a misconfigured or
 * unavailable authorization server must fail the call, not silently send
 * it unauthenticated.
 */
export async function getAccessToken(): Promise<string | null> {
  if (config.fhir.auth.mode === "none") return null;

  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }

  if (!pendingToken) {
    pendingToken = fetchAccessToken().finally(() => {
      pendingToken = null;
    });
  }
  return pendingToken;
}

async function fetchAccessToken(): Promise<string> {
  const auth = config.fhir.auth;
  if (auth.mode !== "client_credentials") throw new Error("FHIR_AUTH is not client_credentials");

  const now = Date.now();
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (auth.scope) body.set("scope", auth.scope);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (auth.authMethod === "client_secret_basic") {
    // RFC 6749 section 2.3.1: form-encode each part before base64.
    const credentials = `${encodeURIComponent(auth.clientId)}:${encodeURIComponent(auth.clientSecret)}`;
    headers.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
  } else {
    body.set("client_id", auth.clientId);
    body.set("client_secret", auth.clientSecret);
  }

  try {
    const response = await axios.post<TokenResponse>(auth.tokenUrl, body.toString(), { headers, timeout: 10_000 });

    const { access_token, expires_in } = response.data;
    if (!access_token) throw new Error("token response has no access_token");
    // expires_in is optional in RFC 6749; without it, refetch after 5 minutes.
    const lifetime = typeof expires_in === "number" && expires_in > 0 ? expires_in : 300;
    cachedToken = { accessToken: access_token, expiresAt: now + lifetime * 1000 };
    return access_token;
  } catch (err: unknown) {
    const detail = axios.isAxiosError(err)
      ? JSON.stringify(err.response?.data ?? err.message)
      : String(err);
    console.error(`[fhir-auth] Failed to obtain FHIR access token from ${auth.tokenUrl}: ${detail}`);
    throw new Error("Could not obtain an access token for the FHIR server.");
  }
}

/** Clears the cached token, forcing a fresh token on the next request. */
export function clearTokenCache(): void {
  cachedToken = null;
}
