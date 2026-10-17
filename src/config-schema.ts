import { z } from "zod";

/**
 * Pure parsing and validation of the environment into a typed config.
 * Kept free of side effects (no .env loading, no process.env access) so the
 * startup rules can be tested directly; config.ts applies it to process.env.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Asymmetric algorithms only. `none` and HS* are never accepted: with a
// remote JWKS, HS* would let anyone holding the public key forge tokens.
const ALLOWED_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"] as const;

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));
const list = (separator: RegExp) =>
  z
    .string()
    .optional()
    .transform((v) => (v ?? "").split(separator).map((s) => s.trim()).filter(Boolean));
const bool = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true"));

/** An absolute URL that must be https unless it points at this machine. */
function secureUrl(name: string) {
  return z.string().trim().superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must be an absolute URL` });
      return;
    }
    if (url.hash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name} must not contain a #fragment` });
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must use https (http is allowed only for localhost)`,
      });
    }
  });
}

const EnvSchema = z
  .object({
    MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
    PORT: positiveInt(3000),
    HOST: z.string().default("0.0.0.0"),
    MCP_SESSION_IDLE_MINUTES: positiveInt(30),
    MCP_MAX_SESSIONS: positiveInt(100),
    MCP_READ_ONLY: bool(true),
    MCP_ALLOWED_ORIGINS: list(/,/),

    MCP_PUBLIC_URL: secureUrl("MCP_PUBLIC_URL").optional(),
    OAUTH_ISSUER: secureUrl("OAUTH_ISSUER").optional(),
    OAUTH_AUDIENCE: optionalString,
    OAUTH_REQUIRED_SCOPES: z
      .string()
      .default("fhir-mcp:read")
      .transform((v) => v.split(/\s+/).filter(Boolean)),
    OAUTH_JWKS_URI: secureUrl("OAUTH_JWKS_URI").optional(),
    OAUTH_ALGORITHMS: z
      .string()
      .default("RS256,ES256")
      .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
      .pipe(z.array(z.enum(ALLOWED_ALGORITHMS)).min(1)),
    OAUTH_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(300).default(30),

    FHIR_BASE_URL: z.string().trim().url(),
    FHIR_AUTH: z.enum(["none", "client_credentials"]).default("none"),
    PINGONE_ENV_ID: optionalString,
    PINGONE_CLIENT_ID: optionalString,
    PINGONE_CLIENT_SECRET: optionalString,
  })
  .superRefine((env, ctx) => {
    // Fail closed: there is deliberately no switch that runs HTTP without auth.
    if (env.MCP_TRANSPORT === "http") {
      for (const name of ["MCP_PUBLIC_URL", "OAUTH_ISSUER"] as const) {
        if (!env[name]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `${name} is required when MCP_TRANSPORT=http (the HTTP transport always requires OAuth)`,
          });
        }
      }
    }
    if (env.FHIR_AUTH === "client_credentials") {
      for (const name of ["PINGONE_ENV_ID", "PINGONE_CLIENT_ID", "PINGONE_CLIENT_SECRET"] as const) {
        if (!env[name]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `${name} is required when FHIR_AUTH=client_credentials`,
          });
        }
      }
    }
  });

export interface OAuthConfig {
  /** Exact `iss` value tokens must carry, e.g. AIC's `https://<tenant>:443/am/oauth2/realms/root/realms/alpha`. */
  issuer: string;
  /** Value that must appear in the token's `aud`. Defaults to the public MCP URL. */
  audience: string;
  requiredScopes: string[];
  /** Overrides the jwks_uri from the issuer's discovery document. */
  jwksUri?: string;
  algorithms: string[];
  clockSkewSeconds: number;
}

export type FhirAuthConfig =
  | { mode: "none" }
  | { mode: "client_credentials"; clientId: string; clientSecret: string; tokenUrl: string };

export interface Config {
  server: {
    transport: "stdio" | "http";
    port: number;
    host: string;
    sessionIdleMinutes: number;
    maxSessions: number;
    /** Canonical URL clients use to reach /mcp; the OAuth resource identifier. */
    publicUrl?: string;
    allowedOrigins: string[];
  };
  tools: { readOnly: boolean };
  /** Present whenever the HTTP transport is selected; null for stdio. */
  oauth: OAuthConfig | null;
  fhir: { baseUrl: string; version: "R4"; auth: FhirAuthConfig };
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid configuration:\n${problems}\nCopy .env.example to .env and fill in the values.`
    );
  }
  const e = result.data;

  const oauth: OAuthConfig | null =
    e.MCP_TRANSPORT === "http"
      ? {
          issuer: e.OAUTH_ISSUER!,
          audience: e.OAUTH_AUDIENCE ?? e.MCP_PUBLIC_URL!,
          requiredScopes: e.OAUTH_REQUIRED_SCOPES,
          jwksUri: e.OAUTH_JWKS_URI,
          algorithms: e.OAUTH_ALGORITHMS,
          clockSkewSeconds: e.OAUTH_CLOCK_SKEW_SECONDS,
        }
      : null;

  const fhirAuth: FhirAuthConfig =
    e.FHIR_AUTH === "client_credentials"
      ? {
          mode: "client_credentials",
          clientId: e.PINGONE_CLIENT_ID!,
          clientSecret: e.PINGONE_CLIENT_SECRET!,
          tokenUrl: `https://auth.pingone.com/${e.PINGONE_ENV_ID}/as/token`,
        }
      : { mode: "none" };

  return {
    server: {
      transport: e.MCP_TRANSPORT,
      port: e.PORT,
      host: e.HOST,
      sessionIdleMinutes: e.MCP_SESSION_IDLE_MINUTES,
      maxSessions: e.MCP_MAX_SESSIONS,
      publicUrl: e.MCP_PUBLIC_URL,
      allowedOrigins: e.MCP_ALLOWED_ORIGINS,
    },
    tools: { readOnly: e.MCP_READ_ONLY },
    oauth,
    fhir: { baseUrl: e.FHIR_BASE_URL, version: "R4", auth: fhirAuth },
  };
}
