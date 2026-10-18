import {
  type FhirSearchParams,
  getPatientEverything,
  readResource,
  searchResource,
} from "./fhir-client.js";

/**
 * Limits tool calls to one patient's data (MCP_PATIENT_SCOPED).
 *
 * The outbound FHIR token is the server's own system-level token, which can
 * read every patient, so this module is what keeps a signed-in member to
 * their own records. Every function takes the caller's patient id from the
 * verified access token; when it is undefined (stdio, or scoping turned
 * off) the call passes through unchanged.
 *
 * The rules, all fail-closed:
 * - Patient-data types (PATIENT_TYPES) are searched with
 *   `patient=Patient/{id}` forced onto the query, which FHIR ANDs with any
 *   other parameters. Reads by id become that search plus `_id`.
 *   (Compartment search, `/Patient/{id}/{type}`, would be the textbook way,
 *   but Smile CDR answers it with 400 not-supported.)
 * - Patient itself: only the caller's own id.
 * - A short list of shared, non-patient types (practitioners, organizations,
 *   medications, terminology) is read and searched as normal.
 * - Every other type is refused.
 * - `_revinclude`, `_has`, `_contained`, `_filter` and `_query` are refused,
 *   and so is a `patient`/`subject`/`beneficiary` value naming anyone else.
 * - Every result is checked as well: a patient-data resource is returned
 *   only if it references the caller's Patient, and any other Patient is
 *   dropped. This covers `_include`, `$everything`, and a FHIR server that
 *   ignored the forced parameter.
 */

/**
 * Patient-data types searched by forcing their `patient` search parameter.
 * All are in the R4 Patient compartment and define `patient`; Smile CDR
 * rejects an unknown parameter with 400, so a wrong entry fails closed.
 * Compartment types without a `patient` parameter (Group, Schedule,
 * AdverseEvent, ...) are left out, and so refused.
 */
const PATIENT_TYPES = new Set([
  "Account", "AllergyIntolerance", "Appointment", "AppointmentResponse", "AuditEvent", "Basic",
  "BodyStructure", "CarePlan", "CareTeam", "ChargeItem", "Claim", "ClaimResponse", "ClinicalImpression",
  "Communication", "CommunicationRequest", "Composition", "Condition", "Consent", "Coverage",
  "CoverageEligibilityRequest", "CoverageEligibilityResponse", "DetectedIssue", "Device", "DeviceRequest",
  "DeviceUseStatement", "DiagnosticReport", "DocumentManifest", "DocumentReference", "Encounter",
  "EnrollmentRequest", "EpisodeOfCare", "ExplanationOfBenefit", "FamilyMemberHistory", "Flag", "Goal",
  "ImagingStudy", "Immunization", "ImmunizationEvaluation", "ImmunizationRecommendation", "Invoice", "List",
  "MeasureReport", "Media", "MedicationAdministration", "MedicationDispense", "MedicationRequest",
  "MedicationStatement", "MolecularSequence", "NutritionOrder", "Observation", "Procedure", "Provenance",
  "QuestionnaireResponse", "RelatedPerson", "RequestGroup", "RiskAssessment", "ServiceRequest", "Specimen",
  "SupplyDelivery", "VisionPrescription",
]);

/** Types that hold no patient's data, so any member may read them. */
const SHARED_TYPES = new Set([
  "Practitioner", "PractitionerRole", "Organization", "OrganizationAffiliation", "Location",
  "HealthcareService", "Endpoint", "InsurancePlan", "Medication", "MedicationKnowledge", "Substance",
  "ValueSet", "CodeSystem", "ConceptMap", "NamingSystem", "StructureDefinition", "SearchParameter",
  "OperationDefinition", "CapabilityStatement", "Questionnaire", "PlanDefinition", "ActivityDefinition",
  "Library", "Measure",
]);

const REFUSED_PARAM = /^_(revinclude|contained|has|filter|query)/;
// Search parameters that name the patient. A value naming anyone else is
// refused rather than silently replaced: the caller would otherwise read
// their own data as if it were the other patient's.
const PATIENT_REFERENCE_PARAM = /^(patient|subject|beneficiary)(:Patient)?$/;
const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;

class PatientScopeError extends Error {}

function refuse(message: string): never {
  throw new PatientScopeError(`Access denied: ${message} You can only access your own records.`);
}

/**
 * The patient id a convenience tool should search with. When scoped, it is
 * the caller's own id, and asking for anyone else's is refused.
 */
export function patientParam(scope: string | undefined, requested: string | undefined): string | undefined {
  if (!scope) return requested;
  if (requested !== undefined && !isSelf(requested, scope)) refuse(`patient "${requested}" is not you.`);
  return scope;
}

export async function scopedSearch(scope: string | undefined, opts: FhirSearchParams): Promise<unknown> {
  if (!scope) return searchResource(opts);

  if (opts.revIncludes?.length) refuse("_revinclude is not available.");
  for (const [key, value] of Object.entries(opts.searchParams ?? {})) {
    if (REFUSED_PARAM.test(key)) refuse(`the ${key} parameter is not available.`);
    if (PATIENT_REFERENCE_PARAM.test(key)) {
      for (const ref of [value].flat().flatMap((v) => v.split(","))) {
        if (!isSelf(ref, scope)) refuse(`${key}="${ref}" is not you.`);
      }
    }
  }

  const { resourceType } = opts;
  let result: unknown;
  if (resourceType === "Patient") {
    const requested = opts.searchParams?._id;
    for (const id of [requested ?? []].flat().flatMap((v) => v.split(","))) {
      if (id !== scope) refuse(`Patient "${id}" is not you.`);
    }
    result = await searchResource({ ...opts, searchParams: { ...opts.searchParams, _id: scope } });
  } else if (PATIENT_TYPES.has(resourceType)) {
    result = await searchResource({ ...opts, searchParams: { ...opts.searchParams, patient: `Patient/${scope}` } });
  } else if (SHARED_TYPES.has(resourceType)) {
    result = await searchResource(opts);
  } else {
    refuse(`${resourceType} resources are not available.`);
  }
  return filterBundle(result, scope);
}

export async function scopedRead(scope: string | undefined, resourceType: string, id: string): Promise<unknown> {
  if (!scope || SHARED_TYPES.has(resourceType)) return readResource(resourceType, id);

  if (resourceType === "Patient") {
    if (id !== scope) refuse(`Patient "${id}" is not you.`);
    return readResource(resourceType, id);
  }
  if (!PATIENT_TYPES.has(resourceType)) refuse(`${resourceType} resources are not available.`);
  if (!FHIR_ID.test(id)) throw new Error(`Invalid FHIR id: "${id}" (expected 1-64 of A-Z a-z 0-9 - .)`);

  const bundle = await searchResource({ resourceType, searchParams: { _id: id, patient: `Patient/${scope}` } });
  const found = entriesOf(bundle)
    .map((e) => e.resource)
    .find((r) => r?.resourceType === resourceType && r.id === id && referencesPatient(r, scope));
  // Same answer whether it doesn't exist or belongs to someone else.
  if (!found) throw new Error(`${resourceType}/${id} was not found in your records.`);
  return found;
}

export async function scopedEverything(
  scope: string | undefined,
  patientId: string | undefined,
  params: Record<string, string>
): Promise<unknown> {
  if (!scope) {
    if (!patientId) throw new Error("patientId is required.");
    return getPatientEverything(patientId, params);
  }
  if (patientId !== undefined && patientId !== scope) refuse(`Patient "${patientId}" is not you.`);
  // $everything returns the compartment plus what it references; the filter
  // still drops any other patient it pulls in (e.g. through Patient.link).
  return filterBundle(await getPatientEverything(scope, params), scope);
}

// ── Result filtering ──────────────────────────────────────────────────────────

interface Resource {
  resourceType?: string;
  id?: string;
}
interface Entry {
  resource?: Resource;
}

function entriesOf(bundle: unknown): Entry[] {
  const entry = (bundle as { entry?: unknown } | null)?.entry;
  return Array.isArray(entry) ? (entry as Entry[]) : [];
}

/** Drops every entry the caller may not see; see the rules at the top. */
function filterBundle(bundle: unknown, scope: string): unknown {
  const entries = entriesOf(bundle);
  if (entries.length === 0) return bundle;
  const allowed = ({ resource }: Entry): boolean => {
    if (!resource) return true;
    const type = resource.resourceType ?? "";
    if (type === "Patient") return resource.id === scope;
    if (type === "OperationOutcome" || SHARED_TYPES.has(type)) return true;
    return PATIENT_TYPES.has(type) && referencesPatient(resource, scope);
  };
  const kept = entries.filter(allowed);
  if (kept.length === entries.length) return bundle;
  return { ...(bundle as object), entry: kept };
}

/**
 * Whether any `reference` in the resource points at Patient/{scope}:
 * relative, absolute, or versioned (`.../Patient/1/_history/2`). Contained
 * resources don't count, since they say nothing about whose resource it is.
 */
function referencesPatient(resource: unknown, scope: string): boolean {
  const target = patientReference(scope);
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (value === null || typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]) =>
      key === "contained" ? false : key === "reference" && typeof child === "string" ? target.test(child) : visit(child)
    );
  };
  return visit(resource);
}

/** Matches a relative, absolute or versioned reference to Patient/{scope}. */
function patientReference(scope: string): RegExp {
  return new RegExp(`(^|/)Patient/${scope.replace(/[.\-]/g, "\\$&")}(/_history/[^/]+)?$`);
}

/** A search or tool value naming the caller: their bare id, or a reference to their Patient. */
function isSelf(value: string, scope: string): boolean {
  const trimmed = value.trim();
  return trimmed === scope || patientReference(scope).test(trimmed);
}
