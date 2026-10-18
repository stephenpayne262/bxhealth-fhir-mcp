import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import axios from "axios";

// FHIR_AUTH=none (the default): no token request, no Authorization header.
// Separate file because config is read once per process.

let server: Server;
const authHeaders: (string | undefined)[] = [];
let tokenCalls = 0;
let client: typeof import("../src/fhir-client");

before(async () => {
  server = createServer((req, res) => {
    authHeaders.push(req.headers.authorization);
    res.writeHead(200, { "Content-Type": "application/fhir+json" });
    res.end(JSON.stringify({ resourceType: "Patient", id: "1" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  for (const name of ["FHIR_AUTH", "FHIR_TOKEN_URL", "FHIR_CLIENT_ID", "FHIR_CLIENT_SECRET", "FHIR_SCOPE"]) {
    delete process.env[name];
  }
  process.env.FHIR_BASE_URL = `http://127.0.0.1:${port}/fhir`;
  axios.post = (async () => {
    tokenCalls++;
    throw new Error("no token request expected");
  }) as typeof axios.post;

  client = require("../src/fhir-client");
});

after(() => {
  server.close();
});

test("requests go out without a token and nothing asks for one", async () => {
  await client.readResource("Patient", "1");
  assert.deepEqual(authHeaders, [undefined]);
  assert.equal(tokenCalls, 0);
});
