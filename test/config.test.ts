import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config-schema";

const base = { FHIR_BASE_URL: "https://fhir.example.com/fhir" };
const http = {
  ...base,
  MCP_TRANSPORT: "http",
  MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
  OAUTH_ISSUER: "https://tenant.example.com:443/am/oauth2/realms/root/realms/alpha",
};

describe("transport and fail-closed rules", () => {
  test("stdio needs only the FHIR URL and has no OAuth", () => {
    const config = parseConfig(base);
    assert.equal(config.server.transport, "stdio");
    assert.equal(config.oauth, null);
    assert.deepEqual(config.fhir.auth, { mode: "none" });
  });

  test("http without MCP_PUBLIC_URL or OAUTH_ISSUER refuses to start", () => {
    assert.throws(() => parseConfig({ ...base, MCP_TRANSPORT: "http" }), /MCP_PUBLIC_URL is required[\s\S]*OAUTH_ISSUER is required/);
  });

  test("http builds OAuth config with defaults", () => {
    const { oauth } = parseConfig(http);
    assert.deepEqual(oauth, {
      issuer: http.OAUTH_ISSUER,
      audience: http.MCP_PUBLIC_URL,
      requiredScopes: ["fhir-mcp:read"],
      jwksUri: undefined,
      algorithms: ["RS256", "ES256"],
      clockSkewSeconds: 30,
      clientPolicy: { mode: "public", allowedClientIds: [] },
      patientClaim: "patient",
    });
  });

  test("patient scoping is on by default, its claim is configurable, and it needs read-only", () => {
    assert.equal(parseConfig({ ...http, OAUTH_PATIENT_CLAIM: "fhirUser" }).oauth?.patientClaim, "fhirUser");
    assert.equal(parseConfig({ ...http, MCP_PATIENT_SCOPED: "false" }).oauth?.patientClaim, undefined);
    assert.throws(() => parseConfig({ ...http, MCP_READ_ONLY: "false" }), /MCP_READ_ONLY: must be true when MCP_PATIENT_SCOPED=true/);
    assert.doesNotThrow(() => parseConfig({ ...http, MCP_READ_ONLY: "false", MCP_PATIENT_SCOPED: "false" }));
  });

  test("OAUTH_AUDIENCE and scopes can be overridden", () => {
    const { oauth } = parseConfig({ ...http, OAUTH_AUDIENCE: "my-client", OAUTH_REQUIRED_SCOPES: "a  b" });
    assert.equal(oauth?.audience, "my-client");
    assert.deepEqual(oauth?.requiredScopes, ["a", "b"]);
  });

  test("the issuer is kept exactly as given, including :443", () => {
    assert.equal(parseConfig(http).oauth?.issuer, http.OAUTH_ISSUER);
  });
});

describe("client mode", () => {
  const PATTERN = "https://cimd.example.com/clients/*";

  test("public mode takes a list of client IDs", () => {
    const { oauth } = parseConfig({ ...http, OAUTH_ALLOWED_CLIENT_IDS: "fhir-mcp-public, other" });
    assert.deepEqual(oauth?.clientPolicy, { mode: "public", allowedClientIds: ["fhir-mcp-public", "other"] });
  });

  test("public mode refuses URL client IDs and CIMD patterns", () => {
    assert.throws(
      () => parseConfig({ ...http, OAUTH_ALLOWED_CLIENT_IDS: "https://cimd.example.com/c.json" }),
      /OAUTH_ALLOWED_CLIENT_IDS: .* is a URL/
    );
    assert.throws(
      () => parseConfig({ ...http, OAUTH_CIMD_CLIENT_ID_PATTERNS: PATTERN }),
      /OAUTH_CIMD_CLIENT_ID_PATTERNS: is only used when OAUTH_CLIENT_MODE=cimd/
    );
  });

  test("cimd mode takes URL patterns", () => {
    const { oauth } = parseConfig({ ...http, OAUTH_CLIENT_MODE: "cimd", OAUTH_CIMD_CLIENT_ID_PATTERNS: PATTERN });
    assert.deepEqual(oauth?.clientPolicy, { mode: "cimd", patterns: [PATTERN] });
  });

  test("cimd mode refuses to start without patterns, or with public client IDs", () => {
    assert.throws(
      () => parseConfig({ ...http, OAUTH_CLIENT_MODE: "cimd" }),
      /OAUTH_CIMD_CLIENT_ID_PATTERNS: is required when OAUTH_CLIENT_MODE=cimd/
    );
    assert.throws(
      () => parseConfig({ ...http, OAUTH_CLIENT_MODE: "cimd", OAUTH_CIMD_CLIENT_ID_PATTERNS: PATTERN, OAUTH_ALLOWED_CLIENT_IDS: "x" }),
      /OAUTH_ALLOWED_CLIENT_IDS: is only used when OAUTH_CLIENT_MODE=public/
    );
  });

  test("cimd mode reports each unusable pattern", () => {
    assert.throws(
      () => parseConfig({ ...http, OAUTH_CLIENT_MODE: "cimd", OAUTH_CIMD_CLIENT_ID_PATTERNS: "http://a.example/*,https://*.example/x" }),
      /"http:\/\/a.example\/\*" must use https[\s\S]*wildcard host/
    );
  });

  test("an unknown mode is refused", () => {
    assert.throws(() => parseConfig({ ...http, OAUTH_CLIENT_MODE: "dcr" }), /OAUTH_CLIENT_MODE/);
  });

  test("client mode settings are ignored for stdio", () => {
    assert.doesNotThrow(() => parseConfig({ ...base, OAUTH_CLIENT_MODE: "cimd" }));
  });
});

describe("URL rules", () => {
  test("http:// public URL is refused for a non-loopback host", () => {
    assert.throws(() => parseConfig({ ...http, MCP_PUBLIC_URL: "http://mcp.example.com/mcp" }), /must use https/);
  });

  test("http:// is allowed for localhost and 127.0.0.1", () => {
    assert.doesNotThrow(() => parseConfig({ ...http, MCP_PUBLIC_URL: "http://localhost:3000/mcp" }));
    assert.doesNotThrow(() => parseConfig({ ...http, OAUTH_ISSUER: "http://127.0.0.1:9000/issuer" }));
  });

  test("http:// issuer is refused for a non-loopback host", () => {
    assert.throws(() => parseConfig({ ...http, OAUTH_ISSUER: "http://idp.example.com" }), /OAUTH_ISSUER must use https/);
  });

  test("fragments and relative URLs are refused", () => {
    assert.throws(() => parseConfig({ ...http, MCP_PUBLIC_URL: "https://mcp.example.com/mcp#x" }), /fragment/);
    assert.throws(() => parseConfig({ ...http, MCP_PUBLIC_URL: "/mcp" }), /absolute URL/);
  });
});

describe("algorithms", () => {
  for (const alg of ["none", "HS256"]) {
    test(`${alg} is refused`, () => {
      assert.throws(() => parseConfig({ ...http, OAUTH_ALGORITHMS: `RS256,${alg}` }), /OAUTH_ALGORITHMS/);
    });
  }
});

describe("tools and FHIR auth", () => {
  test("read-only is the default and can be turned off explicitly", () => {
    assert.equal(parseConfig(base).tools.readOnly, true);
    assert.equal(parseConfig({ ...base, MCP_READ_ONLY: "false" }).tools.readOnly, false);
    assert.throws(() => parseConfig({ ...base, MCP_READ_ONLY: "no" }), /MCP_READ_ONLY/);
  });

  const clientCredentials = {
    ...base,
    FHIR_AUTH: "client_credentials",
    FHIR_TOKEN_URL: "https://issuer.example.com/am/oauth2/realms/root/realms/alpha/access_token",
    FHIR_CLIENT_ID: "id",
    FHIR_CLIENT_SECRET: "secret",
  };

  test("client_credentials requires a token URL, client ID and secret", () => {
    assert.throws(() => parseConfig({ ...base, FHIR_AUTH: "client_credentials" }), /FHIR_TOKEN_URL is required/);
    assert.throws(() => parseConfig({ ...clientCredentials, FHIR_CLIENT_SECRET: "" }), /FHIR_CLIENT_SECRET is required/);
    assert.deepEqual(parseConfig(clientCredentials).fhir.auth, {
      mode: "client_credentials",
      tokenUrl: clientCredentials.FHIR_TOKEN_URL,
      clientId: "id",
      clientSecret: "secret",
      scope: undefined,
      authMethod: "client_secret_basic",
    });
  });

  test("scope and client_secret_post are passed through", () => {
    const auth = parseConfig({
      ...clientCredentials,
      FHIR_SCOPE: "system/*.read",
      FHIR_TOKEN_AUTH_METHOD: "client_secret_post",
    }).fhir.auth;
    assert.equal(auth.mode === "client_credentials" && auth.scope, "system/*.read");
    assert.equal(auth.mode === "client_credentials" && auth.authMethod, "client_secret_post");
    assert.throws(() => parseConfig({ ...clientCredentials, FHIR_TOKEN_AUTH_METHOD: "private_key_jwt" }), /FHIR_TOKEN_AUTH_METHOD/);
  });

  test("the token URL must be https unless on localhost", () => {
    assert.throws(() => parseConfig({ ...clientCredentials, FHIR_TOKEN_URL: "http://issuer.example.com/token" }), /FHIR_TOKEN_URL must use https/);
  });

  test("the old PINGONE_* variables are rejected", () => {
    assert.throws(() => parseConfig({ ...clientCredentials, PINGONE_ENV_ID: "env" }), /PINGONE_ENV_ID: is no longer read/);
  });
});
