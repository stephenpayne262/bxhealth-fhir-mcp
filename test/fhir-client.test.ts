import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import axios from "axios";

// A stub FHIR server records each request; `respond` decides the reply.
interface Recorded {
  method: string;
  url: string;
  authorization?: string;
}

let server: Server;
let requests: Recorded[] = [];
let respond: (req: IncomingMessage) => { status: number; body: unknown } = () => ({
  status: 200,
  body: { resourceType: "Bundle" },
});

// Stub the PingOne token call; auth.ts uses the default axios export.
let tokenCalls = 0;
let nextToken = "token-1";

let client: typeof import("../src/fhir-client");
let auth: typeof import("../src/auth");

before(async () => {
  server = createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization });
    req.resume();
    req.on("end", () => {
      const { status, body } = respond(req);
      res.writeHead(status, { "Content-Type": "application/fhir+json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  // config.ts reads these at import time, so set them before loading src/.
  process.env.PINGONE_ENV_ID = "test-env";
  process.env.PINGONE_CLIENT_ID = "test-client";
  process.env.PINGONE_CLIENT_SECRET = "test-secret";
  process.env.FHIR_BASE_URL = `http://127.0.0.1:${port}/fhir`;

  axios.post = (async () => {
    tokenCalls++;
    await new Promise((r) => setTimeout(r, 10));
    return { data: { access_token: nextToken, token_type: "Bearer", expires_in: 3600 } };
  }) as typeof axios.post;

  client = require("../src/fhir-client");
  auth = require("../src/auth");
});

after(() => {
  server.close();
});

beforeEach(() => {
  requests = [];
  tokenCalls = 0;
  nextToken = "token-1";
  auth.clearTokenCache();
  respond = () => ({ status: 200, body: { resourceType: "Bundle" } });
});

describe("search parameters", () => {
  test("array values are sent as repeated keys, not key[]", async () => {
    await client.searchResource({
      resourceType: "Observation",
      searchParams: { date: ["ge2020-01-01", "le2020-12-31"] },
      includes: ["Observation:patient", "Observation:subject"],
    });
    const url = decodeURIComponent(requests[0].url);
    assert.match(url, /date=ge2020-01-01&date=le2020-12-31/);
    assert.match(url, /_include=Observation:patient&_include=Observation:subject/);
    assert.doesNotMatch(url, /\[\]/);
  });
});

describe("path building", () => {
  test("rejects ids that would change the URL", async () => {
    for (const id of ["../Organization/9", "123/_history/1", "x?_format=xml", ""]) {
      await assert.rejects(client.deleteResource("Patient", id), /Invalid FHIR id/);
    }
    assert.equal(requests.length, 0);
  });

  test("rejects invalid resource types", async () => {
    await assert.rejects(client.readResource("patient/../x", "1"), /Invalid FHIR resource type/);
  });

  test("rejects invalid version ids", async () => {
    await assert.rejects(client.vreadResource("Patient", "1", "../2"), /Invalid FHIR versionId/);
  });

  test("builds instance paths", async () => {
    await client.vreadResource("Patient", "abc-1.2", "3");
    assert.equal(requests[0].url, "/fhir/Patient/abc-1.2/_history/3");
  });
});

describe("executeOperation", () => {
  test("accepts names with or without a leading $", async () => {
    await client.executeOperation("$expand", "ValueSet");
    await client.executeOperation("expand", "ValueSet");
    assert.deepEqual(
      requests.map((r) => r.url),
      ["/fhir/ValueSet/$expand", "/fhir/ValueSet/$expand"]
    );
  });

  test("system-level operation", async () => {
    await client.executeOperation("process-message", undefined, undefined, {});
    assert.equal(requests[0].url, "/fhir/$process-message");
    assert.equal(requests[0].method, "POST");
  });

  test("rejects an id without a resourceType", async () => {
    await assert.rejects(client.executeOperation("everything", undefined, "123"), /needs resourceType/);
  });
});

describe("auth", () => {
  test("concurrent requests share one token fetch", async () => {
    await Promise.all([1, 2, 3, 4, 5].map((i) => client.readResource("Patient", String(i))));
    assert.equal(tokenCalls, 1);
    assert.ok(requests.every((r) => r.authorization === "Bearer token-1"));
  });

  test("a 401 clears the cached token and retries once", async () => {
    await client.readResource("Patient", "1"); // caches token-1
    nextToken = "token-2";
    respond = (req) =>
      req.headers.authorization === "Bearer token-1"
        ? { status: 401, body: { resourceType: "OperationOutcome", issue: [] } }
        : { status: 200, body: { resourceType: "Patient", id: "1" } };

    const result = await client.readResource("Patient", "1");
    assert.deepEqual(result, { resourceType: "Patient", id: "1" });
    assert.deepEqual(
      requests.map((r) => r.authorization),
      ["Bearer token-1", "Bearer token-1", "Bearer token-2"]
    );
  });

  test("a second 401 is reported, not retried again", async () => {
    respond = () => ({ status: 401, body: { resourceType: "OperationOutcome", issue: [] } });
    await assert.rejects(client.readResource("Patient", "1"), /HTTP 401/);
    assert.equal(requests.length, 2);
  });
});
