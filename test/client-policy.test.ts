import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { clientRejection, patternProblem, type ClientPolicy } from "../src/oauth/client-policy";

const cimd = (...patterns: string[]): ClientPolicy => ({ mode: "cimd", patterns });
const allowed = (clientId: string | undefined, policy: ClientPolicy) => clientRejection(clientId, policy) === null;

describe("public mode", () => {
  test("an empty list accepts any client, including none", () => {
    const policy: ClientPolicy = { mode: "public", allowedClientIds: [] };
    assert.ok(allowed("anything", policy));
    assert.ok(allowed(undefined, policy));
  });

  test("a list matches exactly", () => {
    const policy: ClientPolicy = { mode: "public", allowedClientIds: ["fhir-mcp-public"] };
    assert.ok(allowed("fhir-mcp-public", policy));
    for (const id of ["FHIR-MCP-PUBLIC", "fhir-mcp-public2", "fhir-mcp", undefined]) {
      assert.ok(!allowed(id, policy), String(id));
    }
  });
});

describe("cimd mode: exact URL pattern", () => {
  const policy = cimd("https://cimd.example.com/clients/claude-code.json");

  test("the exact URL is accepted", () => {
    assert.ok(allowed("https://cimd.example.com/clients/claude-code.json", policy));
  });

  test("anything else is refused", () => {
    for (const id of [
      "https://cimd.example.com/clients/claude-code.json.evil",
      "https://cimd.example.com/clients/other.json",
      "http://cimd.example.com/clients/claude-code.json",
      "https://cimd.example.com:8443/clients/claude-code.json",
      "https://evil.example/clients/claude-code.json",
      "fhir-mcp-public",
      undefined,
    ]) {
      assert.ok(!allowed(id, policy), String(id));
    }
  });
});

describe("cimd mode: prefix pattern", () => {
  const policy = cimd("https://cimd.example.com/clients/*");

  test("documents under the prefix, at any depth, are accepted", () => {
    assert.ok(allowed("https://cimd.example.com/clients/claude-code.json", policy));
    assert.ok(allowed("https://cimd.example.com/clients/team/inspector.json", policy));
  });

  test("the prefix itself, siblings and look-alike hosts are refused", () => {
    for (const id of [
      "https://cimd.example.com/clients/",
      "https://cimd.example.com/clients",
      "https://cimd.example.com/clientsevil/x.json",
      "https://cimd.example.com.attacker.example/clients/x.json",
      "https://attacker.example/https://cimd.example.com/clients/x.json",
    ]) {
      assert.ok(!allowed(id, policy), id);
    }
  });

  test("non-canonical client IDs are refused, so the URL compared is the URL fetched", () => {
    for (const id of [
      "https://cimd.example.com/clients/../admin/x.json",
      "https://cimd.example.com/clients/%2e%2e/admin/x.json",
      "https://cimd.example.com/clients/./x.json",
      "https://CIMD.example.com/clients/x.json",
      "https://cimd.example.com:443/clients/x.json",
      "https://cimd.example.com/clients/x.json?v=1",
      "https://cimd.example.com/clients/x.json#frag",
      "https://user:pw@cimd.example.com/clients/x.json",
      " https://cimd.example.com/clients/x.json",
    ]) {
      assert.ok(!allowed(id, policy), id);
    }
  });

  test("a pattern with an explicit port matches only that port", () => {
    const withPort = cimd("https://cimd.example.com:8443/clients/*");
    assert.ok(allowed("https://cimd.example.com:8443/clients/x.json", withPort));
    assert.ok(!allowed("https://cimd.example.com/clients/x.json", withPort));
  });

  test("a pattern written with :443 or an uppercase host still matches the canonical URL", () => {
    assert.ok(allowed("https://cimd.example.com/clients/x.json", cimd("https://CIMD.example.com:443/clients/*")));
  });

  test("any of several patterns may match", () => {
    const policy = cimd("https://a.example/x.json", "https://b.example/c/*");
    assert.ok(allowed("https://a.example/x.json", policy));
    assert.ok(allowed("https://b.example/c/y.json", policy));
    assert.ok(!allowed("https://a.example/c/y.json", policy));
  });

  test("ChatGPT and hosted documents can be allowed without trusting other URLs", () => {
    const policy = cimd(
      "https://bxhealth-fhir-mcp.ping-devops.com/cimd/*",
      "https://chatgpt.com/oauth/*"
    );
    for (const id of [
      "https://bxhealth-fhir-mcp.ping-devops.com/cimd/claude-code.json",
      "https://chatgpt.com/oauth/client.json",
      "https://chatgpt.com/oauth/callback-id/client.json",
    ]) {
      assert.ok(allowed(id, policy), id);
    }
    for (const id of [
      "https://chatgpt.com/other/client.json",
      "https://chatgpt.com/oauthevil/client.json",
      "https://chatgpt.com.attacker.example/oauth/client.json",
      "https://other.example/oauth/client.json",
    ]) {
      assert.ok(!allowed(id, policy), id);
    }
  });

  test("the reason names what failed", () => {
    assert.match(clientRejection(undefined, policy) ?? "", /no client_id/);
    assert.match(clientRejection("fhir-mcp-public", policy) ?? "", /not a canonical https/);
    assert.match(clientRejection("https://other.example/x.json", policy) ?? "", /does not match/);
  });
});

describe("pattern validation", () => {
  test("usable patterns", () => {
    for (const p of ["https://h.example/x.json", "https://h.example/*", "https://h.example/a/b/*", "https://h.example:8443/a/*"]) {
      assert.equal(patternProblem(p), null, p);
    }
  });

  test("unusable patterns", () => {
    const cases: Array<[string, RegExp]> = [
      ["not a url", /absolute URL/],
      ["https://h.example:*/a/*", /absolute URL/],
      ["http://h.example/a/*", /https/],
      ["https://*.example/a/*", /wildcard host/],
      ["https://h.example", /include a path/],
      ["https://h.example/", /include a path/],
      ["https://h.example/a*/x", /final path segment/],
      ["https://h.example/*/x.json", /final path segment/],
      ["https://h.example/a/**", /final path segment/],
      ["https://h.example/a/*?x=1", /query/],
      ["https://u:p@h.example/a/*", /credentials/],
    ];
    for (const [pattern, problem] of cases) {
      assert.match(patternProblem(pattern) ?? "(accepted)", problem, pattern);
    }
  });
});
