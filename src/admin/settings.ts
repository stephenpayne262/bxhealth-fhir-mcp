/**
 * The settings the admin console can edit: every variable in .env.example /
 * .env.k8s except the ones that must stay environment-only.
 *
 * Not editable here, on purpose: MCP_ADMIN and MCP_ADMIN_PASSWORD (a
 * compromised session must not be able to change or lock out the login),
 * MCP_TRANSPORT and PORT (would take the console and probes offline), and
 * MCP_DATA_DIR (where these overrides live).
 */
export interface SettingMeta {
  key: string;
  group: string;
  description: string;
  secret?: boolean;
}

export const SETTINGS: SettingMeta[] = [
  { key: "MCP_PUBLIC_URL", group: "Server", description: "Canonical public https URL of /mcp; also the default token audience." },
  { key: "MCP_READ_ONLY", group: "Server", description: "true hides and blocks every write tool." },
  { key: "MCP_PATIENT_SCOPED", group: "Server", description: "true limits each caller to their own patient's records (requires MCP_READ_ONLY=true)." },
  { key: "MCP_ALLOWED_ORIGINS", group: "Server", description: "Comma-separated browser origins allowed to call /mcp." },
  { key: "MCP_SESSION_IDLE_MINUTES", group: "Server", description: "Idle minutes before an MCP session is swept." },
  { key: "MCP_MAX_SESSIONS", group: "Server", description: "Maximum concurrent MCP sessions." },
  { key: "OAUTH_ISSUER", group: "OAuth", description: "Authorization server issuer; must exactly match its discovery document." },
  { key: "OAUTH_AUDIENCE", group: "OAuth", description: "Expected token audience. Blank uses MCP_PUBLIC_URL." },
  { key: "OAUTH_REQUIRED_SCOPES", group: "OAuth", description: "Scopes every token must carry (comma or space separated)." },
  { key: "OAUTH_JWKS_URI", group: "OAuth", description: "Override for the JWKS URL. Blank uses discovery." },
  { key: "OAUTH_ALGORITHMS", group: "OAuth", description: "Allowed JWT signing algorithms (asymmetric only)." },
  { key: "OAUTH_CLOCK_SKEW_SECONDS", group: "OAuth", description: "Clock skew tolerance, 0-300 seconds." },
  { key: "OAUTH_CLIENT_MODE", group: "OAuth", description: "public (allow-list of client IDs) or cimd (client ID metadata document URLs)." },
  { key: "OAUTH_ALLOWED_CLIENT_IDS", group: "OAuth", description: "Public mode only: comma-separated accepted client IDs." },
  { key: "OAUTH_CIMD_CLIENT_ID_PATTERNS", group: "OAuth", description: "CIMD mode only: comma-separated exact URLs or /* prefixes." },
  { key: "OAUTH_PATIENT_CLAIM", group: "OAuth", description: "Token claim holding the caller's FHIR patient id." },
  { key: "FHIR_BASE_URL", group: "FHIR", description: "Base URL of the FHIR R4 server." },
  { key: "FHIR_AUTH", group: "FHIR", description: "none or client_credentials (outbound auth to FHIR)." },
  { key: "FHIR_TOKEN_URL", group: "FHIR", description: "Token endpoint for the client_credentials grant." },
  { key: "FHIR_CLIENT_ID", group: "FHIR", description: "Client ID for the client_credentials grant." },
  { key: "FHIR_CLIENT_SECRET", group: "FHIR", description: "Client secret for the client_credentials grant.", secret: true },
  { key: "FHIR_SCOPE", group: "FHIR", description: "Optional scope for the client_credentials grant." },
  { key: "FHIR_TOKEN_AUTH_METHOD", group: "FHIR", description: "client_secret_basic or client_secret_post." },
];

export const SETTING_KEYS = new Set(SETTINGS.map((s) => s.key));
export const SECRET_KEYS = new Set(SETTINGS.filter((s) => s.secret).map((s) => s.key));
