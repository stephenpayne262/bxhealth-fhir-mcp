import { FHIR_ID } from "../fhir-id.js";

/**
 * Reads the caller's FHIR Patient id from an access token claim
 * (OAUTH_PATIENT_CLAIM). Pure, so the accepted forms are tested directly.
 *
 * Accepted: a bare id (`123`, as AIC's `patient` claim carries it), a
 * relative reference (`Patient/123`), or an absolute one
 * (`https://fhir.example.com/fhir/Patient/123`, the SMART `fhirUser` form).
 * A reference to any other resource type, such as `Practitioner/9`, is
 * refused, as is anything that isn't a valid FHIR id.
 */
export function patientIdFromClaim(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value.trim().split("/");
  const id = parts[parts.length - 1];
  if (parts.length > 1 && parts[parts.length - 2] !== "Patient") return undefined;
  return FHIR_ID.test(id) ? id : undefined;
}
