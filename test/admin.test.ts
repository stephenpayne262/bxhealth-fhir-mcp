import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PUBLIC_URL = "https://mcp.example.test/mcp";
const USER = "admin-user";
const PASS = "correct horse battery";
const FHIR_SECRET = "super-secret-fhir-value";

let server: Server;
let base: string;
let dataDir: string;
let restarts = 0;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "admin-test-"));
  // A previously saved override must be applied at startup.
  writeFileSync(join(dataDir, "admin-overrides.json"), JSON.stringify({ version: 1, settings: { MCP_MAX_SESSIONS: "7" }, cimd: {} }));
  Object.assign(process.env, {
    MCP_TRANSPORT: "http",
    MCP_PUBLIC_URL: PUBLIC_URL,
    OAUTH_ISSUER: "https://issuer.example.test/oauth2",
    OAUTH_REQUIRED_SCOPES: "fhir-mcp:read",
    OAUTH_CLIENT_MODE: "cimd",
    OAUTH_CIMD_CLIENT_ID_PATTERNS: "https://mcp.example.test/cimd/*",
    MCP_PATIENT_SCOPED: "false",
    FHIR_BASE_URL: "http://127.0.0.1:1/fhir",
    FHIR_AUTH: "client_credentials",
    FHIR_TOKEN_URL: "https://issuer.example.test/token",
    FHIR_CLIENT_ID: "agent",
    FHIR_CLIENT_SECRET: FHIR_SECRET,
    MCP_ADMIN: USER,
    MCP_ADMIN_PASSWORD: PASS,
    MCP_DATA_DIR: dataDir,
  });
  console.error = () => undefined;
  const { buildApp } = require("../src/http") as typeof import("../src/http");
  const verifier = { init: async () => undefined, getStatus: () => ({ state: "ready" }) } as never;
  server = createServer(buildApp({ verifier, restart: () => void restarts++ }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface Result { status: number; body: any; text: string; headers: Headers }

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; csrf?: string; origin?: string } = {}): Promise<Result> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.csrf) headers["X-CSRF-Token"] = opts.csrf;
  if (opts.origin) headers.Origin = opts.origin;
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: res.status, body, text, headers: res.headers };
}

async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await call("POST", "/admin/api/login", { body: { username: USER, password: PASS } });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  return { cookie, csrf: res.body.csrf };
}

describe("admin console", () => {
  test("serves the page with a strict CSP and requires a session for the API", async () => {
    const page = await fetch(`${base}/admin`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    for (const path of ["/admin/api/settings", "/admin/api/export", "/admin/api/cimd"]) {
      assert.equal((await call("GET", path)).status, 401);
    }
  });

  test("rejects bad credentials and sets a hardened cookie on success", async () => {
    assert.equal((await call("POST", "/admin/api/login", { body: { username: USER, password: "nope" } })).status, 401);
    assert.equal((await call("POST", "/admin/api/login", { body: { username: "x", password: PASS } })).status, 401);
    assert.equal((await call("POST", "/admin/api/login", { body: {} })).status, 401);
    const ok = await call("POST", "/admin/api/login", { body: { username: USER, password: PASS } });
    const cookie = ok.headers.get("set-cookie")!;
    assert.match(cookie, /^__Host-admin_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
  });

  test("lists settings, applies startup overrides, and never reveals secrets", async () => {
    const { cookie } = await login();
    const res = await call("GET", "/admin/api/settings", { cookie });
    const byKey = Object.fromEntries(res.body.settings.map((s: any) => [s.key, s]));
    assert.equal(byKey.MCP_MAX_SESSIONS.value, "7");
    assert.equal(byKey.FHIR_CLIENT_SECRET.value, "");
    assert.equal(byKey.FHIR_CLIENT_SECRET.isSet, true);
    assert.ok(!res.text.includes(FHIR_SECRET));
    assert.ok(!("MCP_ADMIN_PASSWORD" in byKey) && !res.text.includes(PASS));
  });

  test("writes need the CSRF token and a same-origin Origin", async () => {
    const { cookie, csrf } = await login();
    const body = { values: { MCP_MAX_SESSIONS: "9" } };
    assert.equal((await call("PUT", "/admin/api/settings", { cookie, body })).status, 403);
    assert.equal((await call("PUT", "/admin/api/settings", { cookie, csrf: "wrong", body })).status, 403);
    assert.equal((await call("PUT", "/admin/api/settings", { cookie, csrf, body, origin: "https://evil.example" })).status, 403);
    assert.equal(restarts, 0);
  });

  test("invalid settings are rejected without saving; valid ones save and restart", async () => {
    const { cookie, csrf } = await login();
    const bad = await call("PUT", "/admin/api/settings", { cookie, csrf, body: { values: { OAUTH_ISSUER: "http://insecure.example" } } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /OAUTH_ISSUER/);
    assert.equal((await call("PUT", "/admin/api/settings", { cookie, csrf, body: { values: { MCP_ADMIN: "x" } } })).status, 400);
    assert.equal((await call("PUT", "/admin/api/settings", { cookie, csrf, body: { values: { NOPE: "x" } } })).status, 400);
    assert.equal(restarts, 0);

    const ok = await call("PUT", "/admin/api/settings", { cookie, csrf, body: { values: { MCP_MAX_SESSIONS: "9", FHIR_CLIENT_SECRET: "" } } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.restarting, true);
    assert.equal(restarts, 1);
    const saved = JSON.parse(readFileSync(join(dataDir, "admin-overrides.json"), "utf8"));
    assert.equal(saved.settings.MCP_MAX_SESSIONS, "9");
    assert.ok(!("FHIR_CLIENT_SECRET" in saved.settings));
  });

  test("export omits secrets; import validates then applies", async () => {
    const { cookie, csrf } = await login();
    const exported = await call("GET", "/admin/api/export", { cookie });
    assert.equal(exported.body.version, 1);
    assert.equal(exported.body.settings.FHIR_BASE_URL, process.env.FHIR_BASE_URL);
    assert.ok(!exported.text.includes(FHIR_SECRET) && !exported.text.includes(PASS));
    assert.ok(exported.body.cimd["claude-code"]);

    assert.equal((await call("POST", "/admin/api/import", { cookie, csrf, body: { version: 2 } })).status, 400);
    const badDoc = await call("POST", "/admin/api/import", { cookie, csrf, body: { version: 1, cimd: { x: { redirect_uris: [] } } } });
    assert.equal(badDoc.status, 400);

    const before = restarts;
    const ok = await call("POST", "/admin/api/import", { cookie, csrf, body: { ...exported.body, settings: { ...exported.body.settings, MCP_SESSION_IDLE_MINUTES: "12" } } });
    assert.equal(ok.status, 200);
    assert.equal(restarts, before + 1);
  });

  test("CIMD documents can be added, edited, served and removed", async () => {
    const { cookie, csrf } = await login();
    const doc = { client_name: "Mine", redirect_uris: ["https://example.com/cb"], client_id: "https://attacker.example/x.json", token_endpoint_auth_method: "none" };
    const put = await call("PUT", "/admin/api/cimd/my-client", { cookie, csrf, body: { document: doc } });
    assert.equal(put.status, 200);
    assert.equal(put.body.url, "https://mcp.example.test/cimd/my-client.json");

    const served = await call("GET", "/cimd/my-client.json");
    assert.equal(served.status, 200);
    assert.equal(served.body.client_id, "https://mcp.example.test/cimd/my-client.json");
    assert.deepEqual(served.body.redirect_uris, ["https://example.com/cb"]);

    // Edit a built-in, then reset it.
    const builtin = (await call("GET", "/cimd/claude-code.json")).body;
    await call("PUT", "/admin/api/cimd/claude-code", { cookie, csrf, body: { document: { ...builtin, client_name: "Edited" } } });
    assert.equal((await call("GET", "/cimd/claude-code.json")).body.client_name, "Edited");
    assert.equal((await call("DELETE", "/admin/api/cimd/claude-code", { cookie, csrf })).status, 200);
    assert.notEqual((await call("GET", "/cimd/claude-code.json")).body.client_name, "Edited");

    assert.equal((await call("DELETE", "/admin/api/cimd/my-client", { cookie, csrf })).status, 200);
    assert.equal((await call("GET", "/cimd/my-client.json")).status, 404);
    assert.equal((await call("DELETE", "/admin/api/cimd/my-client", { cookie, csrf })).status, 404);
  });

  test("CIMD validation rejects unsafe documents and names", async () => {
    const { cookie, csrf } = await login();
    const put = (name: string, document: unknown) => call("PUT", `/admin/api/cimd/${name}`, { cookie, csrf, body: { document } });
    assert.equal((await put("a", { redirect_uris: ["http://evil.example/cb"] })).status, 400);
    assert.equal((await put("a", { redirect_uris: ["https://ok.example/cb"], client_secret: "x" })).status, 400);
    assert.equal((await put("a", { redirect_uris: ["https://ok.example/cb"], token_endpoint_auth_method: "client_secret_basic" })).status, 400);
    assert.equal((await put("a", { redirect_uris: ["https://ok.example/cb"], pad: "x".repeat(6000) })).status, 400);
    assert.equal((await put("Bad_Name", { redirect_uris: ["https://ok.example/cb"] })).status, 400);
    assert.equal((await put("a", "not an object")).status, 400);
  });

  test("logout ends the session", async () => {
    const { cookie, csrf } = await login();
    assert.equal((await call("POST", "/admin/api/logout", { cookie, csrf, body: {} })).status, 200);
    assert.equal((await call("GET", "/admin/api/settings", { cookie })).status, 401);
  });

  test("repeated failed logins are locked out", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call("POST", "/admin/api/login", { body: { username: USER, password: "wrong" } })).status;
    assert.equal(last, 429);
    // Even the right password is refused during lockout.
    assert.equal((await call("POST", "/admin/api/login", { body: { username: USER, password: PASS } })).status, 429);
  });
});
