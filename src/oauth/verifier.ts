import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthConfig } from "../config-schema.js";
import { IssuerMismatchError, fetchIssuerMetadata } from "./discovery.js";

/**
 * Validates access tokens as JWTs against the issuer's JWKS (RFC 9068 style).
 *
 * Checked on every request: signature (key chosen by `kid`), algorithm
 * allowlist, `iss` (exact), `aud` (must contain our resource identifier),
 * `exp`/`nbf` with clock skew, and presence of `sub`. Scope is checked by
 * the SDK's requireBearerAuth against the scopes returned here.
 *
 * Errors sent to clients are deliberately generic; the specific reason is
 * logged server-side. Raw tokens are never logged.
 */

export type OAuthStatus =
  | { state: "pending" }
  | { state: "ready"; jwksUri: string }
  | { state: "error"; reason: string };

type Jwks = ReturnType<typeof createRemoteJWKSet>;

export class JwtTokenVerifier implements OAuthTokenVerifier {
  private jwks: Promise<Jwks> | null = null;
  private status: OAuthStatus = { state: "pending" };
  private permanentError: string | null = null;

  constructor(
    private readonly config: OAuthConfig,
    /** Overrides for JWKS caching; tests shorten the refetch cooldown. */
    private readonly jwksOptions: { cooldownDuration?: number } = {}
  ) {}

  /** Current discovery/JWKS state, for /readyz. */
  getStatus(): OAuthStatus {
    return this.status;
  }

  /**
   * Resolves the JWKS once, sharing the in-flight attempt. A transient failure
   * is retried on the next request; an issuer mismatch is a configuration
   * error and stays failed until the process is restarted with a fix.
   */
  init(): Promise<Jwks> {
    if (this.permanentError) return Promise.reject(new Error(this.permanentError));
    if (!this.jwks) {
      this.jwks = this.resolveJwks().catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.status = { state: "error", reason };
        if (error instanceof IssuerMismatchError) this.permanentError = reason;
        console.error(`[oauth] ${reason}`);
        this.jwks = null;
        throw error;
      });
    }
    return this.jwks;
  }

  private async resolveJwks(): Promise<Jwks> {
    // Discovery runs even with an OAUTH_JWKS_URI override, so the issuer is
    // still confirmed against the authorization server's own metadata.
    const metadata = await fetchIssuerMetadata(this.config.issuer);
    const jwksUri = this.config.jwksUri ?? metadata.jwks_uri;
    const jwks = createRemoteJWKSet(new URL(jwksUri), {
      timeoutDuration: 5_000,
      // An unknown `kid` triggers a refetch (key rotation), at most this often.
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
      ...this.jwksOptions,
    });
    this.status = { state: "ready", jwksUri };
    console.error(`[oauth] issuer ${this.config.issuer} ready; JWKS ${jwksUri}`);
    return jwks;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let jwks: Jwks;
    try {
      jwks = await this.init();
    } catch {
      throw new ServerError("Authorization server metadata is unavailable");
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: this.config.algorithms,
        clockTolerance: this.config.clockSkewSeconds,
        requiredClaims: ["exp", "sub"],
      }));
    } catch (error: unknown) {
      if (isJwksUnavailable(error)) {
        console.error(`[oauth] JWKS fetch failed: ${describe(error)}`);
        throw new ServerError("Authorization server keys are unavailable");
      }
      console.error(`[oauth] rejected token: ${describe(error)}`);
      throw new InvalidTokenError("The access token is invalid or expired");
    }

    return {
      token,
      clientId: stringClaim(payload, "client_id") ?? stringClaim(payload, "azp") ?? "unknown",
      scopes: scopesOf(payload),
      expiresAt: payload.exp,
      extra: { sub: payload.sub, iss: payload.iss, jti: payload.jti },
    };
  }
}

function stringClaim(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === "string" && value ? value : undefined;
}

/** `scope` is a space-delimited string (RFC 9068); some servers use `scp` as an array or string. */
function scopesOf(payload: JWTPayload): string[] {
  const raw = payload.scope ?? payload.scp;
  if (typeof raw === "string") return raw.split(/\s+/).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  return [];
}

function isJwksUnavailable(error: unknown): boolean {
  if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid) return true;
  // fetch() network failures surface as plain errors, not JOSE errors.
  return error instanceof Error && !(error instanceof joseErrors.JOSEError);
}

function describe(error: unknown): string {
  if (error instanceof joseErrors.JOSEError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
