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
  expires_in: number;
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
 * With FHIR_AUTH=client_credentials, uses PingOne client_credentials with
 * client_secret_basic, caches the token, and refreshes it 30 seconds before
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
  // PingOne requires client_secret_basic: credentials go in the Authorization header,
  // not in the POST body (client_secret_post is not supported for this app).
  const basicCredentials = Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString("base64");

  try {
    const response = await axios.post<TokenResponse>(
      auth.tokenUrl,
      "grant_type=client_credentials",
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basicCredentials}`,
        },
        timeout: 10_000,
      }
    );

    const { access_token, expires_in } = response.data;
    cachedToken = { accessToken: access_token, expiresAt: now + expires_in * 1000 };
    return access_token;
  } catch (err: unknown) {
    const detail = axios.isAxiosError(err)
      ? JSON.stringify(err.response?.data ?? err.message)
      : String(err);
    console.error(`[fhir-auth] Failed to obtain FHIR access token: ${detail}`);
    throw new Error("Could not obtain an access token for the FHIR server.");
  }
}

/** Clears the cached token, forcing a fresh token on the next request. */
export function clearTokenCache(): void {
  cachedToken = null;
}
