import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// Patient-scoped mode (MCP_PATIENT_SCOPED, on by default for HTTP). The tool
// handlers are called directly as patient "p1" against a stub FHIR server
// that answers with data from several patients; the token side is covered
// in oauth.test.ts ("patient claim").

let server: Server;
let requests: string[] = [];
let tools: typeof import("../src/tools").tools;
let availableTools: typeof import("../src/server").availableTools;

const match = (resource: object) => ({ resource, search: { mode: "match" } });
const include = (resource: object) => ({ resource, search: { mode: "include" } });
const bundle = (...entry: object[]) => ({ resourceType: "Bundle", type: "searchset", entry });

const o1 = { resourceType: "Observation", id: "o1", subject: { reference: "Patient/p1" } };
// Someone else's, as if the FHIR server had ignored the forced patient parameter.
const o2 = { resourceType: "Observation", id: "o2", subject: { reference: "Patient/p2" } };
// Someone else's; only a contained resource mentions p1.
const o3 = {
  resourceType: "Observation",
  id: "o3",
  subject: { reference: "Patient/p2" },
  contained: [{ resourceType: "Provenance", target: [{ reference: "Patient/p1" }] }],
};
const p1 = { resourceType: "Patient", id: "p1" };
const p2 = { resourceType: "Patient", id: "p2" };
const p10 = { resourceType: "Encounter", id: "e10", subject: { reference: "Patient/p10" } };
const practitioner = { resourceType: "Practitioner", id: "dr" };
const e1 = { resourceType: "Encounter", id: "e1", subject: { reference: "https://fhir.example.com/fhir/Patient/p1/_history/3" } };
const e9 = { resourceType: "Encounter", id: "e9" };

function respond(url: URL): unknown {
  const path = url.pathname;
  if (path === "/fhir/Observation") {
    if (url.searchParams.get("_id") === "o2") return bundle(match(o2));
    return bundle(match(o1), match(o2), match(o3), include(p1), include(p2), include(practitioner), include(e1), include(e9), include(p10));
  }
  if (path === "/fhir/Patient/p1/$everything") {
    return bundle(match(p1), match(o1), match(o2), match(p2), match(practitioner), match({ resourceType: "Binary", id: "b" }));
  }
  if (path === "/fhir/Patient/p1") return p1;
  if (path === "/fhir/Practitioner/dr") return practitioner;
  return bundle(match(practitioner));
}

before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url!);
    res.writeHead(200, { "Content-Type": "application/fhir+json" });
    res.end(JSON.stringify(respond(new URL(req.url!, "http://stub"))));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  // config.ts reads these at import time. Nothing contacts the issuer here.
  Object.assign(process.env, {
    MCP_TRANSPORT: "http",
    MCP_PUBLIC_URL: "http://localhost:3000/mcp",
    OAUTH_ISSUER: "https://issuer.example.com",
    FHIR_AUTH: "none",
    FHIR_BASE_URL: `http://127.0.0.1:${port}/fhir`,
  });
  delete process.env.MCP_PATIENT_SCOPED;
  ({ tools } = require("../src/tools"));
  ({ availableTools } = require("../src/server"));
});

after(() => {
  server.close();
});

beforeEach(() => {
  requests = [];
});

// `null` calls with no patient, as stdio or MCP_PATIENT_SCOPED=false do.
async function call(name: string, args: object, patient: string | null = "p1"): Promise<any> {
  const tool = tools.find((t) => t.name === name)!;
  return JSON.parse(await tool.handler(tool.inputSchema.parse(args), { patient: patient ?? undefined }));
}

const ids = (result: any) => result.entry.map((e: any) => `${e.resource.resourceType}/${e.resource.id}`);
const path = (url: string) => decodeURIComponent(url.split("?")[0]);

describe("tool set", () => {
  test("tools that can't be limited to one patient are hidden", () => {
    const names = availableTools().map((t) => t.name);
    for (const hidden of ["fhir_search_patients", "fhir_vread_resource", "fhir_resource_history", "fhir_type_history", "fhir_execute_operation"]) {
      assert.ok(!names.includes(hidden), hidden);
    }
    for (const shown of ["fhir_read_resource", "fhir_search_resources", "fhir_patient_everything", "fhir_search_observations"]) {
      assert.ok(names.includes(shown), shown);
    }
  });
});

describe("search", () => {
  test("patient-data types are searched with the caller forced in, and other patients' data is filtered out", async () => {
    const result = await call("fhir_search_resources", {
      resourceType: "Observation",
      searchParams: { subject: "Patient/p1", code: "1234-5" },
      includes: ["Observation:subject"],
    });
    assert.equal(path(requests[0]), "/fhir/Observation");
    const query = new URL(requests[0], "http://stub").searchParams;
    assert.deepEqual(query.getAll("patient"), ["Patient/p1"]);
    assert.equal(query.get("subject"), "Patient/p1");
    assert.equal(query.get("code"), "1234-5");
    assert.deepEqual(ids(result), ["Observation/o1", "Patient/p1", "Practitioner/dr", "Encounter/e1"]);
  });

  test("Patient search is pinned to the caller's own id", async () => {
    await call("fhir_search_resources", { resourceType: "Patient", searchParams: { family: "Smith" } });
    assert.match(requests[0], /^\/fhir\/Patient\?.*_id=p1/);
    await assert.rejects(call("fhir_search_resources", { resourceType: "Patient", searchParams: { _id: "p2" } }), /Access denied/);
    await assert.rejects(call("fhir_search_resources", { resourceType: "Patient", searchParams: { _id: "p1,p2" } }), /Access denied/);
  });

  test("shared types are searched normally; other types and risky parameters are refused", async () => {
    await call("fhir_search_resources", { resourceType: "Practitioner" });
    assert.equal(path(requests[0]), "/fhir/Practitioner");
    for (const args of [
      { resourceType: "Binary" },
      { resourceType: "Bundle" },
      { resourceType: "Observation", revIncludes: ["Provenance:target"] },
      { resourceType: "Observation", searchParams: { "_revinclude:iterate": "Provenance:target" } },
      { resourceType: "Practitioner", searchParams: { "_has:Observation:performer:subject": "Patient/p2" } },
      { resourceType: "Observation", searchParams: { _contained: "true" } },
      { resourceType: "Observation", searchParams: { _filter: "subject eq Patient/p2" } },
      { resourceType: "Group" },
    ]) {
      await assert.rejects(call("fhir_search_resources", args), /Access denied/, JSON.stringify(args));
    }
    assert.equal(requests.length, 1);
  });

  test("naming another patient is refused, not silently replaced with the caller", async () => {
    for (const searchParams of [
      { patient: "p2" },
      { patient: "Patient/p10" },
      { "subject:Patient": "https://fhir.example.com/fhir/Patient/p2" },
      { subject: "Group/g1" },
      { beneficiary: ["p1", "p2"] },
      { patient: "p1,p2" },
    ]) {
      await assert.rejects(call("fhir_search_resources", { resourceType: "Observation", searchParams }), /Access denied/, JSON.stringify(searchParams));
    }
    assert.equal(requests.length, 0);
    // The caller's own id, in any form, is fine.
    for (const patient of ["p1", "Patient/p1", "https://fhir.example.com/fhir/Patient/p1"]) {
      await call("fhir_search_resources", { resourceType: "Observation", searchParams: { patient } });
    }
    assert.equal(requests.length, 3);
  });

  test("convenience tools search as the caller and refuse another patient", async () => {
    await call("fhir_search_observations", {});
    assert.equal(path(requests[0]), "/fhir/Observation");
    assert.deepEqual(new URL(requests[0], "http://stub").searchParams.getAll("patient"), ["Patient/p1"]);
    await assert.rejects(call("fhir_search_observations", { patientId: "p2" }), /Access denied/);
  });

  test("_elements and _summary=text are applied after the filter, so the caller's resources survive", async () => {
    for (const args of [
      { elements: ["status"] },
      { searchParams: { _elements: "Observation.status" } },
      { summary: "text" },
      { searchParams: { _summary: "text" } },
    ]) {
      requests = [];
      const result = await call("fhir_search_resources", { resourceType: "Observation", ...args });
      const query = new URL(requests[0], "http://stub").searchParams;
      assert.equal(query.get("_elements"), null, JSON.stringify(args));
      assert.equal(query.get("_summary"), null, JSON.stringify(args));
      assert.deepEqual(ids(result), ["Observation/o1", "Patient/p1", "Practitioner/dr", "Encounter/e1"], JSON.stringify(args));
      // The match is trimmed; included resources stay whole.
      assert.deepEqual(result.entry[0].resource, { resourceType: "Observation", id: "o1" }, JSON.stringify(args));
      assert.deepEqual(result.entry[3].resource, e1);
    }
    await call("fhir_search_resources", { resourceType: "Observation", summary: "count" });
    assert.equal(new URL(requests.at(-1)!, "http://stub").searchParams.get("_summary"), "count");
  });

  test("without a patient (stdio, or scoping off) searches pass through", async () => {
    await call("fhir_search_resources", { resourceType: "Observation" }, null);
    assert.equal(path(requests[0]), "/fhir/Observation");
  });
});

describe("read", () => {
  test("a patient-data resource is read as a search with the caller forced in", async () => {
    assert.deepEqual(await call("fhir_read_resource", { resourceType: "Observation", id: "o1" }), o1);
    assert.equal(decodeURIComponent(requests[0]), "/fhir/Observation?_id=o1&patient=Patient/p1");
  });

  test("someone else's resource looks the same as a missing one", async () => {
    await assert.rejects(call("fhir_read_resource", { resourceType: "Observation", id: "o2" }), /not found in your records/);
  });

  test("only the caller's own Patient, shared types directly, nothing else", async () => {
    assert.deepEqual(await call("fhir_read_resource", { resourceType: "Patient", id: "p1" }), p1);
    assert.deepEqual(await call("fhir_read_resource", { resourceType: "Practitioner", id: "dr" }), practitioner);
    await assert.rejects(call("fhir_read_resource", { resourceType: "Patient", id: "p2" }), /Access denied/);
    await assert.rejects(call("fhir_read_resource", { resourceType: "Binary", id: "b" }), /Access denied/);
    assert.deepEqual(requests.map(path), ["/fhir/Patient/p1", "/fhir/Practitioner/dr"]);
  });
});

describe("$everything", () => {
  test("only for the caller, with other patients and unlisted types removed", async () => {
    const result = await call("fhir_patient_everything", { patientId: "p1" });
    assert.deepEqual(ids(result), ["Patient/p1", "Observation/o1", "Practitioner/dr"]);
    assert.deepEqual(ids(await call("fhir_patient_everything", {})), ["Patient/p1", "Observation/o1", "Practitioner/dr"]);
    await assert.rejects(call("fhir_patient_everything", { patientId: "p2" }), /Access denied/);
  });
});
