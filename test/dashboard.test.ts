import { test } from "node:test";
import assert from "node:assert/strict";
import { createDashboardProbe } from "../src/dashboard";

const publicUrl = "https://public.example/mcp";
const issuer = "https://private-issuer.example/realm";
const jwks = "https://private-issuer.example/keys";

function stub(overrides: Record<string, () => Response> = {}, requests: string[] = []): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    requests.push(url);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    if (overrides[url]) return overrides[url]();
    const path = new URL(url).pathname;
    if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, jwks_uri: jwks });
    if (url === jwks) return Response.json({ keys: [{ kty: "RSA", kid: "test-key" }] });
    if (path === "/") return new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } });
    if (path === "/healthz") return Response.json({ status: "ok" });
    if (path === "/readyz") return Response.json({ status: "ready", oauth: { state: "ready" }, fhir: { versionMatches: true, baseUrl: "SECRET-INTERNAL-URL" } });
    if (path.startsWith("/.well-known/oauth-protected-resource")) return Response.json({ resource: publicUrl, authorization_servers: [issuer] });
    if (path.startsWith("/cimd/")) return Response.json({ client_id: url, token_endpoint_auth_method: "none", redirect_uris: ["http://localhost/callback"] });
    if (path === "/mcp") {
      assert.equal(init?.method, "POST");
      return new Response("", { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://public.example/.well-known/oauth-protected-resource/mcp"' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

test("dashboard checks public endpoints, FHIR, discovery and keys without exposing dependency URLs", async () => {
  const requests: string[] = [];
  const probe = createDashboardProbe({ publicUrl, issuer, fetcher: stub({}, requests) });
  const report = await probe();
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 13);
  assert.equal(report.checks.filter(check => check.id.startsWith("cimd-")).length, 4);
  assert.equal(requests.filter(url => url.endsWith("/readyz")).length, 1);
  assert.ok(requests.includes(jwks));
  assert.ok(!JSON.stringify(report).includes("private-issuer"));
  assert.ok(!JSON.stringify(report).includes("SECRET-INTERNAL-URL"));
  assert.ok(!Number.isNaN(Date.parse(report.checkedAt)));
});

test("dashboard shares concurrent refreshes and caches the completed report", async () => {
  const requests: string[] = [];
  const probe = createDashboardProbe({ publicUrl, issuer, fetcher: stub({}, requests) });
  const [first, second] = await Promise.all([probe(), probe()]);
  assert.strictEqual(first, second);
  const count = requests.length;
  assert.strictEqual(await probe(), first);
  assert.equal(requests.length, count);
});

test("FHIR version mismatch, missing JWKS, and wrong CIMD identities are failures", async () => {
  const probe = createDashboardProbe({ publicUrl, issuer, fetcher: stub({
    "https://public.example/readyz": () => Response.json({ status: "ready", oauth: { state: "ready" }, fhir: { versionMatches: false } }),
    [jwks]: () => Response.json({ keys: [] }),
    "https://public.example/cimd/vscode.json": () => Response.json({ client_id: "https://wrong.example/vscode.json" }),
  }) });
  const report = await probe();
  assert.equal(report.ok, false);
  for (const id of ["fhir", "aic-jwks", "cimd-vscode"]) assert.equal(report.checks.find(check => check.id === id)?.ok, false);
  assert.equal(report.checks.find(check => check.id === "health")?.ok, true);
});

test("network failures and timeouts produce sanitized failures, not healthy defaults", async () => {
  const fetcher: typeof fetch = async () => { throw new Error("secret token and private network details"); };
  const report = await createDashboardProbe({ publicUrl, issuer, fetcher })();
  assert.equal(report.ok, false);
  assert.ok(report.checks.every(check => !check.ok));
  assert.ok(!JSON.stringify(report).includes("secret token"));
});

test("discovery mismatch cannot pass and JWKS override is tested independently", async () => {
  const override = "https://configured-keys.example/jwks";
  const report = await createDashboardProbe({ publicUrl, issuer, jwksUri: override, fetcher: stub({
    [`${issuer}/.well-known/openid-configuration`]: () => Response.json({ issuer: "wrong", jwks_uri: jwks }),
    "https://private-issuer.example/.well-known/oauth-authorization-server/realm": () => new Response("", { status: 404 }),
    [override]: () => Response.json({ keys: [{ kty: "EC", kid: "key" }] }),
  }) })();
  assert.equal(report.checks.find(check => check.id === "aic-discovery")?.ok, false);
  assert.equal(report.checks.find(check => check.id === "aic-jwks")?.ok, true);
});

test("oversized metadata and unexpectedly unprotected MCP endpoint fail", async () => {
  const report = await createDashboardProbe({ publicUrl, issuer, fetcher: stub({
    "https://public.example/cimd/claude-code.json": () => Response.json({ padding: "x".repeat(5121) }),
    [publicUrl]: () => Response.json({ ok: true }),
  }) })();
  assert.equal(report.checks.find(check => check.id === "cimd-claude-code")?.ok, false);
  assert.equal(report.checks.find(check => check.id === "mcp-auth")?.ok, false);
});


test("dashboard refreshes expired reports", async (context) => {
  const requests: string[] = [];
  const probe = createDashboardProbe({ publicUrl, issuer, fetcher: stub({}, requests) });
  await probe();
  const count = requests.length;
  const later = Date.now() + 31_000;
  context.mock.method(Date, "now", () => later);
  await probe();
  assert.equal(requests.length, count * 2);
});
