import { test } from "node:test";
import assert from "node:assert/strict";
import { patientIdFromClaim } from "../src/oauth/patient-claim";

test("bare ids and Patient references are accepted", () => {
  assert.equal(patientIdFromClaim("123"), "123");
  assert.equal(patientIdFromClaim("Patient/abc-1.2"), "abc-1.2");
  assert.equal(patientIdFromClaim("https://fhir.example.com/fhir/Patient/123"), "123");
});

test("other types, invalid ids and non-strings are refused", () => {
  for (const value of ["", "Practitioner/9", "Patient/", "Patient/a b", "a/../b", "x".repeat(65), 123, null, undefined, ["123"]]) {
    assert.equal(patientIdFromClaim(value), undefined, JSON.stringify(value));
  }
});
