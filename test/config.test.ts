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
    });
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

  test("client_credentials requires the PingOne settings", () => {
    assert.throws(() => parseConfig({ ...base, FHIR_AUTH: "client_credentials" }), /PINGONE_ENV_ID is required/);
    const config = parseConfig({
      ...base,
      FHIR_AUTH: "client_credentials",
      PINGONE_ENV_ID: "env",
      PINGONE_CLIENT_ID: "id",
      PINGONE_CLIENT_SECRET: "secret",
    });
    assert.equal(config.fhir.auth.mode, "client_credentials");
  });
});
