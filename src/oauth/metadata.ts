import type { Request, Response } from "express";
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthConfig } from "../config-schema.js";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * The 401 from /mcp points clients here; this names the authorization server
 * they should send the user to. `authorization_servers` is the configured
 * issuer verbatim, so a client comparing it with the AS metadata's `issuer`
 * sees an exact match.
 */

/** RFC 9728 §3.1: the well-known segment goes before the resource's path. */
export function protectedResourceMetadataPath(publicUrl: string): string {
  const path = new URL(publicUrl).pathname.replace(/\/$/, "");
  return `/.well-known/oauth-protected-resource${path}`;
}

export function protectedResourceMetadataUrl(publicUrl: string): string {
  return new URL(protectedResourceMetadataPath(publicUrl), publicUrl).href;
}

export function protectedResourceMetadataHandler(publicUrl: string, oauth: OAuthConfig) {
  const body: OAuthProtectedResourceMetadata = {
    resource: publicUrl,
    authorization_servers: [oauth.issuer],
    scopes_supported: oauth.requiredScopes,
    bearer_methods_supported: ["header"],
    resource_name: "bxhealth-fhir-mcp",
  };
  return (_req: Request, res: Response): void => {
    res.set("Cache-Control", "public, max-age=300").json(body);
  };
}
