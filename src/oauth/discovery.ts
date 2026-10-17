import axios from "axios";

/**
 * Authorization server metadata discovery for the configured issuer.
 *
 * Tries OpenID Connect discovery first (`<issuer>/.well-known/openid-configuration`,
 * which is what AIC/AM serves), then RFC 8414 (`/.well-known/oauth-authorization-server`
 * inserted before the issuer's path). Whichever answers must report an `issuer` that
 * matches the configured one byte for byte; RFC 8414 §3.3 requires the check, and it
 * catches the AIC `:443` mismatch at startup instead of on every token.
 */

export interface IssuerMetadata {
  issuer: string;
  jwks_uri: string;
  [key: string]: unknown;
}

export class IssuerMismatchError extends Error {}

export function discoveryUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, "");
  return [
    `${url.origin}${path}/.well-known/openid-configuration`,
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
  ];
}

export async function fetchIssuerMetadata(issuer: string): Promise<IssuerMetadata> {
  const failures: string[] = [];
  for (const url of discoveryUrls(issuer)) {
    try {
      const { data } = await axios.get<Partial<IssuerMetadata>>(url, {
        timeout: 10_000,
        headers: { Accept: "application/json" },
      });
      if (data?.issuer !== issuer) {
        throw new IssuerMismatchError(
          `Issuer metadata at ${url} reports issuer "${data?.issuer}", but OAUTH_ISSUER is "${issuer}". ` +
            "They must match exactly (including any :443 port)."
        );
      }
      if (typeof data.jwks_uri !== "string") {
        throw new Error(`Issuer metadata at ${url} has no jwks_uri`);
      }
      return data as IssuerMetadata;
    } catch (error: unknown) {
      if (error instanceof IssuerMismatchError) throw error;
      failures.push(`${url}: ${axios.isAxiosError(error) ? error.message : String(error)}`);
    }
  }
  throw new Error(`Could not fetch issuer metadata:\n  ${failures.join("\n  ")}`);
}
