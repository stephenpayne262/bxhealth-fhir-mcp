import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK, type JWTPayload } from "jose";

/**
 * End-to-end tests of the authenticated HTTP transport. A stub issuer serves
 * OIDC discovery and a JWKS from keys generated here, so tokens can be minted
 * with any claims; a stub FHIR server answers tool calls. No network or real
 * authorization server is involved.
 */

const PUBLIC_URL = "https://bxhealth-fhir-mcp.ping-devops.com/mcp";
const METADATA_URL = "https://bxhealth-fhir-mcp.ping-devops.com/.well-known/oauth-protected-resource/mcp";
const SCOPE = "fhir-mcp:read";
const ALLOWED_ORIGIN = "http://allowed.example";

let issuerServer: Server;
let fhirServer: Server;
let mcpServer: Server;
let issuer: string;
let mcpBase: string;

const publishedKeys: JWK[] = [];
let jwksHits = 0;

interface SigningKey {
  privateKey: CryptoKey;
  alg: string;
  kid: string;
}
let rsKey: SigningKey;
let ecKey: SigningKey;
let unpublishedKey: SigningKey;
let rs512Key: SigningKey;

let verifierModule: typeof import("../src/oauth/verifier");
let configModule: typeof import("../src/config");

// Captured stderr, to check what the server logs.
const logged: string[] = [];

async function makeKey(alg: string, kid: string, publish: boolean): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg);
  if (publish) publishedKeys.push({ ...(await exportJWK(publicKey)), kid, alg, use: "sig" });
  return { privateKey, alg, kid };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  );
}

before(async () => {
  issuerServer = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/issuer/.well-known/openid-configuration") {
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
    } else if (req.url === "/issuer/jwks") {
      jwksHits++;
      res.end(JSON.stringify({ keys: publishedKeys }));
    } else if (req.url === "/mismatch/.well-known/openid-configuration") {
      res.end(JSON.stringify({ issuer: `${issuer}-other`, jwks_uri: `${issuer}/jwks` }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  issuer = `${await listen(issuerServer)}/issuer`;

  fhirServer = createServer((req, res) => {
    res.setHeader("Content-Type", "application/fhir+json");
    res.end(
      JSON.stringify(
        req.url?.startsWith("/fhir/metadata")
          ? { resourceType: "CapabilityStatement", fhirVersion: "4.0.1" }
          : { resourceType: "Bundle", type: "searchset", total: 0 }
      )
    );
  });
  const fhirBase = await listen(fhirServer);

  rsKey = await makeKey("RS256", "rs-1", true);
  ecKey = await makeKey("ES256", "ec-1", true);
  unpublishedKey = await makeKey("RS256", "rs-1", false); // same kid, different key
  // Published from the start, so its rejection can only be the algorithm.
  rs512Key = await makeKey("RS512", "rs512-1", true);

  Object.assign(process.env, {
    MCP_TRANSPORT: "http",
    MCP_PUBLIC_URL: PUBLIC_URL,
    OAUTH_ISSUER: issuer,
    OAUTH_REQUIRED_SCOPES: SCOPE,
    MCP_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    // The tool set and patient filtering are covered by patient-scope.test.ts;
    // here only the verifier's claim check is tested (see "patient claim").
    MCP_PATIENT_SCOPED: "false",
    FHIR_BASE_URL: `${fhirBase}/fhir`,
  });

  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    if (process.env.TEST_VERBOSE) originalError(...args);
  };

  configModule = require("../src/config");
  verifierModule = require("../src/oauth/verifier");
  const { buildApp } = require("../src/http") as typeof import("../src/http");
  const verifier = new verifierModule.JwtTokenVerifier(configModule.config.oauth!, { cooldownDuration: 1_000 });
  await verifier.init();
  mcpServer = createServer(buildApp({ verifier }));
  mcpBase = await listen(mcpServer);
});

after(() => {
  for (const server of [issuerServer, fhirServer, mcpServer]) server.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = () => Math.floor(Date.now() / 1000);

async function mint(claims: JWTPayload = {}, key: SigningKey = rsKey, omit: string[] = []): Promise<string> {
  const payload: JWTPayload = {
    iss: issuer,
    aud: PUBLIC_URL,
    sub: "alice",
    client_id: "test-client",
    scope: `openid ${SCOPE}`,
    iat: now(),
    exp: now() + 300,
    ...claims,
  };
  for (const name of omit) delete payload[name];
  return new SignJWT(payload).setProtectedHeader({ alg: key.alg, kid: key.kid, typ: "at+jwt" }).sign(key.privateKey);
}

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

interface RpcResult {
  status: number;
  headers: Headers;
  body: any;
}

async function mcp(
  method: "POST" | "GET" | "DELETE",
  { token, body, session, headers = {} }: { token?: string; body?: unknown; session?: string; headers?: Record<string, string> } = {}
): Promise<RpcResult> {
  const res = await fetch(`${mcpBase}/mcp`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(session ? { "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-06-18" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    parsed = data ? JSON.parse(data.slice(6)) : undefined;
  } else if (text) {
    parsed = JSON.parse(text);
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

async function openSession(token: string): Promise<string> {
  const res = await mcp("POST", { token, body: INITIALIZE });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const session = res.headers.get("mcp-session-id");
  assert.ok(session);
  await mcp("POST", { token, session, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  return session;
}

async function assertRejected(token: string, status = 401): Promise<RpcResult> {
  const res = await mcp("POST", { token, body: INITIALIZE });
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("401 challenge", () => {
  test("no Authorization header gets 401 pointing at the resource metadata", async () => {
    const res = await mcp("POST", { body: INITIALIZE });
    assert.equal(res.status, 401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /^Bearer /);
    assert.ok(challenge.includes(`resource_metadata="${METADATA_URL}"`), challenge);
    assert.ok(challenge.includes(`scope="${SCOPE}"`), challenge);
  });

  test("wrong scheme, empty bearer and garbage tokens get 401", async () => {
    for (const authorization of ["Basic dXNlcjpwYXNz", "Bearer", "Bearer not-a-jwt", "Bearer a.b.c"]) {
      const res = await mcp("POST", { body: INITIALIZE, headers: { Authorization: authorization } });
      assert.equal(res.status, 401, authorization);
    }
  });
});

describe("valid tokens", () => {
  test("RS256 token: initialize, list read-only tools, call a tool", async () => {
    const token = await mint();
    const session = await openSession(token);

    const list = await mcp("POST", { token, session, body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    const tools = list.body.result.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    assert.equal(tools.length, 13);
    assert.ok(tools.every((t) => t.annotations.readOnlyHint === true));
    for (const hidden of ["fhir_create_resource", "fhir_delete_resource", "fhir_transaction", "fhir_execute_operation"]) {
      assert.ok(!tools.some((t) => t.name === hidden), hidden);
    }

    const call = await mcp("POST", {
      token,
      session,
      body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fhir_search_patients", arguments: { family: "Smith" } } },
    });
    assert.equal(call.body.result.isError, undefined);
    assert.match(call.body.result.content[0].text, /searchset/);
  });

  test("write tools are refused even when called by name", async () => {
    const token = await mint();
    const session = await openSession(token);
    const call = await mcp("POST", {
      token,
      session,
      body: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "fhir_delete_resource", arguments: { resourceType: "Patient", id: "1" } },
      },
    });
    assert.match(call.body.error.message, /Unknown tool: fhir_delete_resource/);
  });

  test("ES256 token is accepted", async () => {
    await openSession(await mint({}, ecKey));
  });

  test("aud as an array that includes this server is accepted", async () => {
    await openSession(await mint({ aud: ["something-else", PUBLIC_URL] }));
  });

  test("scope as an scp array is accepted", async () => {
    await openSession(await mint({ scp: [SCOPE] }, rsKey, ["scope"]));
  });
});

describe("signature and algorithm", () => {
  test("token signed by an unpublished key with a known kid", async () => {
    await assertRejected(await mint({}, unpublishedKey));
  });

  test("tampered payload", async () => {
    const [header, , signature] = (await mint()).split(".");
    const forged = b64url({ iss: issuer, aud: PUBLIC_URL, sub: "admin", scope: SCOPE, exp: now() + 300 });
    await assertRejected(`${header}.${forged}.${signature}`);
  });

  test("alg none", async () => {
    const payload = b64url({ iss: issuer, aud: PUBLIC_URL, sub: "alice", scope: SCOPE, exp: now() + 300 });
    await assertRejected(`${b64url({ alg: "none", typ: "JWT" })}.${payload}.`);
  });

  test("HS256 signed with a shared secret", async () => {
    const token = await new SignJWT({ iss: issuer, aud: PUBLIC_URL, sub: "alice", scope: SCOPE })
      .setProtectedHeader({ alg: "HS256", kid: "rs-1" })
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("a-shared-secret-of-sufficient-length"));
    await assertRejected(token);
  });

  test("RS512 is valid but not in OAUTH_ALGORITHMS", async () => {
    await assertRejected(await mint({}, rs512Key));
  });
});

describe("time claims", () => {
  test("expired token", async () => {
    await assertRejected(await mint({ exp: now() - 120 }));
  });

  test("expired by less than the skew is still refused", async () => {
    // jwtVerify allows the 30s skew, but the SDK's requireBearerAuth then
    // checks exp against the clock with no skew. So skew applies to nbf/iat
    // only, and an expired token is never accepted.
    const res = await mcp("POST", { token: await mint({ exp: now() - 10 }), body: INITIALIZE });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /Token has expired/);
  });

  test("not-before in the future beyond the skew", async () => {
    await assertRejected(await mint({ nbf: now() + 120 }));
  });

  test("not-before within the skew is accepted", async () => {
    await openSession(await mint({ nbf: now() + 10 }));
  });

  test("missing exp", async () => {
    await assertRejected(await mint({}, rsKey, ["exp"]));
  });
});

describe("issuer, audience and subject", () => {
  test("wrong issuer", async () => {
    await assertRejected(await mint({ iss: "https://evil.example/issuer" }));
  });

  test("issuer differing only by a trailing slash or host spelling", async () => {
    await assertRejected(await mint({ iss: `${issuer}/` }));
    await assertRejected(await mint({ iss: issuer.replace("127.0.0.1", "localhost") }));
  });

  test("wrong audience", async () => {
    await assertRejected(await mint({ aud: "https://other-resource.example/mcp" }));
  });

  test("missing audience", async () => {
    await assertRejected(await mint({}, rsKey, ["aud"]));
  });

  test("missing subject", async () => {
    await assertRejected(await mint({}, rsKey, ["sub"]));
  });
});

describe("client mode", () => {
  // Separate verifiers with an overridden policy, so this suite's server keeps
  // its default (public mode, empty list) for every other test.
  const verifierWith = (clientPolicy: import("../src/oauth/client-policy").ClientPolicy) =>
    new verifierModule.JwtTokenVerifier({ ...configModule.config.oauth!, clientPolicy });
  const CIMD_ID = "https://cimd.example.com/clients/claude-code.json";

  test("the default policy accepts any client, and /readyz reports the mode", async () => {
    await openSession(await mint({ client_id: "whatever" }));
    const body = (await (await fetch(`${mcpBase}/readyz`)).json()) as any;
    assert.equal(body.oauth.clientMode, "public");
  });

  test("public mode with a list refuses other clients, and logs which one", async () => {
    const verifier = verifierWith({ mode: "public", allowedClientIds: ["fhir-mcp-public"] });
    const info = await verifier.verifyAccessToken(await mint({ client_id: "fhir-mcp-public" }));
    assert.equal(info.clientId, "fhir-mcp-public");
    await assert.rejects(verifier.verifyAccessToken(await mint({ client_id: "other-app" })), /invalid or expired/);
    await assert.rejects(verifier.verifyAccessToken(await mint({ client_id: CIMD_ID })), /invalid or expired/);
    assert.ok(logged.some((line) => line.includes('not in OAUTH_ALLOWED_CLIENT_IDS (client_id="other-app")')));
  });

  test("cimd mode accepts a matching document URL from client_id or azp", async () => {
    const verifier = verifierWith({ mode: "cimd", patterns: ["https://cimd.example.com/clients/*"] });
    assert.equal((await verifier.verifyAccessToken(await mint({ client_id: CIMD_ID }))).clientId, CIMD_ID);
    const viaAzp = await verifier.verifyAccessToken(await mint({ azp: CIMD_ID }, rsKey, ["client_id"]));
    assert.equal(viaAzp.clientId, CIMD_ID);
  });

  test("cimd mode refuses the public client, other URLs and tokens without a client", async () => {
    const verifier = verifierWith({ mode: "cimd", patterns: ["https://cimd.example.com/clients/*"] });
    for (const claims of [
      { client_id: "fhir-mcp-public" },
      { client_id: "https://attacker.example/clients/claude-code.json" },
    ]) {
      await assert.rejects(verifier.verifyAccessToken(await mint(claims)), /invalid or expired/, JSON.stringify(claims));
    }
    await assert.rejects(verifier.verifyAccessToken(await mint({}, rsKey, ["client_id"])), /invalid or expired/);
    assert.ok(logged.some((line) => line.includes("token has no client_id or azp")));
  });
});

describe("patient claim", () => {
  const verifier = () => new verifierModule.JwtTokenVerifier({ ...configModule.config.oauth!, patientClaim: "patient" });

  test("the patient id is passed on from the claim", async () => {
    const info = await verifier().verifyAccessToken(await mint({ patient: "123" }));
    assert.equal(info.extra?.patient, "123");
  });

  test("a token without a usable patient claim gets 403, not 401", async () => {
    for (const claims of [{}, { patient: "" }, { patient: "Practitioner/9" }, { patient: "../x" }, { patient: 123 }]) {
      await assert.rejects(
        verifier().verifyAccessToken(await mint(claims)),
        (error: Error) => error.constructor.name === "InsufficientScopeError",
        JSON.stringify(claims)
      );
    }
    assert.ok(logged.some((line) => line.includes('no usable "patient" claim (sub="alice")')));
  });
});

describe("scope", () => {
  test("missing required scope gets 403 insufficient_scope", async () => {
    const res = await assertRejected(await mint({ scope: "openid profile" }), 403);
    const challenge = res.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /error="insufficient_scope"/);
    assert.ok(challenge.includes(`scope="${SCOPE}"`));
  });
});

describe("key rotation", () => {
  test("a new key in the JWKS is picked up after one refetch", async () => {
    await new Promise((r) => setTimeout(r, 1_100)); // past the test cooldown
    const rotated = await makeKey("RS256", "rs-2", true);
    const before = jwksHits;
    await openSession(await mint({}, rotated));
    assert.equal(jwksHits, before + 1);
  });

  test("repeated unknown kids within the cooldown do not hit the JWKS", async () => {
    const stranger = await makeKey("RS256", "unknown-kid", false);
    const before = jwksHits;
    for (let i = 0; i < 5; i++) await assertRejected(await mint({}, stranger));
    assert.ok(jwksHits - before <= 1, `JWKS fetched ${jwksHits - before} times`);
  });
});

describe("sessions", () => {
  test("GET and DELETE on /mcp require a token", async () => {
    const session = await openSession(await mint());
    assert.equal((await mcp("GET", { session })).status, 401);
    assert.equal((await mcp("DELETE", { session })).status, 401);
  });

  test("another identity cannot use a session it did not open", async () => {
    const session = await openSession(await mint({ sub: "alice" }));
    const bob = await mint({ sub: "bob" });
    const res = await mcp("POST", { token: bob, session, body: { jsonrpc: "2.0", id: 5, method: "tools/list" } });
    assert.equal(res.status, 404);
    assert.equal((await mcp("DELETE", { token: bob, session })).status, 404);
  });

  test("the same identity with a fresh token keeps its session, and can close it", async () => {
    const session = await openSession(await mint({ sub: "carol" }));
    const refreshed = await mint({ sub: "carol", jti: "new" });
    const list = await mcp("POST", { token: refreshed, session, body: { jsonrpc: "2.0", id: 6, method: "tools/list" } });
    assert.equal(list.status, 200);
    assert.equal((await mcp("DELETE", { token: refreshed, session })).status, 200);
    assert.equal((await mcp("POST", { token: refreshed, session, body: { jsonrpc: "2.0", id: 7, method: "tools/list" } })).status, 404);
  });
});

describe("public endpoints", () => {
  test("protected resource metadata, at the RFC 9728 path and the root form", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await fetch(`${mcpBase}${path}`);
      assert.equal(res.status, 200, path);
      assert.deepEqual(await res.json(), {
        resource: PUBLIC_URL,
        authorization_servers: [issuer],
        scopes_supported: [SCOPE],
        bearer_methods_supported: ["header"],
        resource_name: "bxhealth-fhir-mcp",
      });
    }
  });

  test("/healthz needs no token", async () => {
    assert.equal((await fetch(`${mcpBase}/healthz`)).status, 200);
  });

  test("/readyz reports OAuth and FHIR status", async () => {
    const res = await fetch(`${mcpBase}/readyz`);
    const body = (await res.json()) as any;
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.oauth.state, "ready");
    assert.equal(body.fhir.versionMatches, true);
  });
});

describe("origin", () => {
  test("a disallowed browser origin gets 403 before auth", async () => {
    const res = await mcp("POST", { token: await mint(), body: INITIALIZE, headers: { Origin: "http://evil.example" } });
    assert.equal(res.status, 403);
  });

  test("an allowed origin gets CORS headers, including on the preflight", async () => {
    const preflight = await fetch(`${mcpBase}/mcp`, { method: "OPTIONS", headers: { Origin: ALLOWED_ORIGIN } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.match(preflight.headers.get("access-control-expose-headers") ?? "", /WWW-Authenticate/);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Authorization/);

    const res = await mcp("POST", { body: INITIALIZE, headers: { Origin: ALLOWED_ORIGIN } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
  });
});

describe("logging", () => {
  test("audit lines identify the caller; tokens and arguments never appear", async () => {
    const token = await mint({ sub: "dave" });
    const session = await openSession(token);
    const secretArg = "Zzyzx-Patient-Name";
    await mcp("POST", {
      token,
      session,
      body: { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "fhir_search_patients", arguments: { family: secretArg } } },
    });
    await assertRejected(await mint({ aud: "wrong" }));

    const output = logged.join("\n");
    const audit = logged.map((l) => (l.startsWith("{") ? JSON.parse(l) : null)).find((e) => e?.sub === "dave");
    assert.deepEqual(
      { event: audit?.event, tool: audit?.tool, outcome: audit?.outcome, client_id: audit?.client_id },
      { event: "tool_call", tool: "fhir_search_patients", outcome: "ok", client_id: "test-client" }
    );
    assert.ok(!output.includes(token), "raw token logged");
    assert.ok(!output.includes(token.split(".")[2]), "token signature logged");
    assert.ok(!output.includes(secretArg), "tool argument logged");
  });
});

describe("issuer discovery", () => {
  test("an issuer mismatch is a permanent configuration error", async () => {
    const verifier = new verifierModule.JwtTokenVerifier({
      ...configModule.config.oauth!,
      issuer: issuer.replace("/issuer", "/mismatch"),
    });
    await assert.rejects(verifier.verifyAccessToken(await mint()), /metadata is unavailable/);
    const status = verifier.getStatus();
    assert.equal(status.state, "error");
    assert.match(status.state === "error" ? status.reason : "", /must match exactly/);
    // Stays failed without retrying discovery.
    await assert.rejects(verifier.init(), /must match exactly/);
  });

  test("an unreachable issuer is reported, then retried on the next request", async () => {
    const verifier = new verifierModule.JwtTokenVerifier({
      ...configModule.config.oauth!,
      issuer: issuer.replace("/issuer", "/missing"),
    });
    await assert.rejects(verifier.verifyAccessToken(await mint()), /metadata is unavailable/);
    assert.equal(verifier.getStatus().state, "error");
    await assert.rejects(verifier.init(), /Could not fetch issuer metadata/);
  });
});

describe("public CIMD documents", () => {
  for (const name of ["claude-ai", "claude-code", "gemini-cli", "mcp-inspector", "vscode"]) {
    test(`${name} is public JSON with the configured client ID`, async () => {
      const path = `/cimd/${name}.json`;
      const response = await fetch(`${mcpBase}${path}`, {
        redirect: "manual",
        headers: { Host: "untrusted.example" },
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      const body = await response.text();
      assert.ok(Buffer.byteLength(body) <= 5 * 1024);
      const document = JSON.parse(body);
      assert.equal(document.client_id, new URL(path, PUBLIC_URL).href);
      assert.equal(document.token_endpoint_auth_method, "none");
      assert.ok(document.redirect_uris.length > 0);
    });
  }

  test("unknown CIMD documents are not exposed", async () => {
    const response = await fetch(`${mcpBase}/cimd/unknown.json`, { redirect: "manual" });
    assert.equal(response.status, 404);
  });
});

test("public landing page serves configured setup commands and self-hosted assets without changing MCP auth", async () => {
  const response = await fetch(`${mcpBase}/`, { headers: { Host: "untrusted.example" } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  const page = await response.text();
  assert.ok(page.includes("BXHEALTH-FHIR-MCP"));
  assert.ok(page.includes("Version 1.1.0"));
  const health = await (await fetch(`${mcpBase}/healthz`)).json() as { version: string };
  assert.equal(health.version, "1.1.0");
  const manifest = require("../package.json") as { version: string };
  assert.equal(health.version, manifest.version);
  assert.ok(page.includes(PUBLIC_URL));
  assert.ok(!page.includes("untrusted.example"));
  assert.ok(!page.includes("{{PUBLIC_URL}}"));
  for (const name of ["claude-code", "gemini-cli", "mcp-inspector", "vscode"]) {
    assert.ok(page.includes(`/cimd/${name}.json`));
  }
  assert.equal((await fetch(`${mcpBase}/dashboard-assets/index.html`)).status, 404);
  for (const asset of ["dashboard.js", "style.css"]) {
    assert.equal((await fetch(`${mcpBase}/dashboard-assets/${asset}`)).status, 200);
  }
  assert.equal((await fetch(`${mcpBase}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
});
