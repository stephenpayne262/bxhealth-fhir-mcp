import axios from "axios";
import { config } from "./config.js";
import { getAccessToken, clearTokenCache } from "./auth.js";
import { FHIR_ID } from "./fhir-id.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface FhirRequestOptions {
  method: HttpMethod;
  path: string;
  body?: unknown;
  params?: Record<string, string | string[]>;
  headers?: Record<string, string>;
}

export interface FhirSearchParams {
  resourceType: string;
  searchParams?: Record<string, string | string[]>;
  count?: number;
  offset?: number;
  sort?: string;
  includes?: string[];
  revIncludes?: string[];
  summary?: "true" | "text" | "data" | "count" | "false";
  elements?: string[];
}

// Built once so keep-alive connections are reused across requests.
//
// paramsSerializer `indexes: null` makes axios send array values as repeated
// keys (`date=ge2020&date=le2021`), which is what FHIR search expects. The
// axios default (`date[]=...`) is silently ignored by FHIR servers.
const client = axios.create({
  baseURL: config.fhir.baseUrl,
  headers: {
    Accept: "application/fhir+json",
    "Content-Type": "application/fhir+json",
    Prefer: "return=representation",
  },
  timeout: 30_000,
  paramsSerializer: { indexes: null },
});

async function fhirRequest<T = unknown>(options: FhirRequestOptions): Promise<T> {
  const send = async (): Promise<T> => {
    const authHeaders: Record<string, string> = {};
    const token = await getAccessToken();
    // null means FHIR_AUTH=none; a failure to get a token throws instead.
    if (token) {
      authHeaders.Authorization = `Bearer ${token}`;
    }

    const response = await client.request<T>({
      method: options.method,
      url: options.path,
      headers: {
        ...authHeaders,
        ...options.headers,
      },
      params: options.params,
      data: options.body,
    });
    return response.data;
  };

  try {
    return await send();
  } catch (error: unknown) {
    // A 401 with a cached token usually means it was revoked or the signing
    // keys rotated. Drop the cache and retry once with a fresh token.
    if (
      config.fhir.auth.mode !== "none" &&
      axios.isAxiosError(error) &&
      error.response?.status === 401
    ) {
      clearTokenCache();
      try {
        return await send();
      } catch (retryError: unknown) {
        throw formatFhirError(retryError);
      }
    }
    throw formatFhirError(error);
  }
}

// ── Path building ─────────────────────────────────────────────────────────────

const RESOURCE_TYPE = /^[A-Z][A-Za-z]+$/;
const OPERATION_NAME = /^[A-Za-z][A-Za-z0-9\-_.]*$/;

function resourceTypeSegment(resourceType: string): string {
  if (!RESOURCE_TYPE.test(resourceType)) {
    throw new Error(`Invalid FHIR resource type: "${resourceType}"`);
  }
  return resourceType;
}

function idSegment(id: string, label = "id"): string {
  if (!FHIR_ID.test(id)) {
    throw new Error(`Invalid FHIR ${label}: "${id}" (expected 1-64 of A-Z a-z 0-9 - .)`);
  }
  return encodeURIComponent(id);
}

function operationSegment(operation: string): string {
  const name = operation.startsWith("$") ? operation.slice(1) : operation;
  if (!OPERATION_NAME.test(name)) {
    throw new Error(`Invalid FHIR operation name: "${operation}"`);
  }
  return `$${name}`;
}

/** Builds `/{resourceType}[/{id}[/_history/{versionId}]]` with every segment validated. */
function resourcePath(resourceType: string, id?: string, versionId?: string): string {
  let path = `/${resourceTypeSegment(resourceType)}`;
  if (id !== undefined) path += `/${idSegment(id)}`;
  if (versionId !== undefined) path += `/_history/${idSegment(versionId, "versionId")}`;
  return path;
}

function formatFhirError(error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const operationOutcome = error.response?.data;
    const message =
      typeof operationOutcome === "object" &&
      operationOutcome !== null &&
      "issue" in operationOutcome
        ? JSON.stringify(operationOutcome, null, 2)
        : error.message;
    return new Error(`FHIR request failed (HTTP ${status}): ${message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

// ── Resource CRUD ─────────────────────────────────────────────────────────────

export async function readResource(resourceType: string, id: string): Promise<unknown> {
  return fhirRequest({ method: "GET", path: resourcePath(resourceType, id) });
}

export async function vreadResource(
  resourceType: string,
  id: string,
  versionId: string
): Promise<unknown> {
  return fhirRequest({ method: "GET", path: resourcePath(resourceType, id, versionId) });
}

export async function createResource(resourceType: string, body: unknown): Promise<unknown> {
  return fhirRequest({ method: "POST", path: resourcePath(resourceType), body });
}

export async function updateResource(
  resourceType: string,
  id: string,
  body: unknown
): Promise<unknown> {
  return fhirRequest({ method: "PUT", path: resourcePath(resourceType, id), body });
}

export async function patchResource(
  resourceType: string,
  id: string,
  patchBody: unknown,
  patchType: "json-patch" | "fhir-patch" = "json-patch"
): Promise<unknown> {
  const contentType =
    patchType === "json-patch"
      ? "application/json-patch+json"
      : "application/fhir+json";
  return fhirRequest({
    method: "PATCH",
    path: resourcePath(resourceType, id),
    body: patchBody,
    headers: { "Content-Type": contentType },
  });
}

export async function deleteResource(resourceType: string, id: string): Promise<unknown> {
  return fhirRequest({ method: "DELETE", path: resourcePath(resourceType, id) });
}

// ── Search ────────────────────────────────────────────────────────────────────

function searchQuery(opts: FhirSearchParams): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = { ...opts.searchParams };

  if (opts.count !== undefined) params["_count"] = String(opts.count);
  if (opts.offset !== undefined) params["_offset"] = String(opts.offset);
  if (opts.sort) params["_sort"] = opts.sort;
  if (opts.summary) params["_summary"] = opts.summary;
  if (opts.elements?.length) params["_elements"] = opts.elements.join(",");
  if (opts.includes?.length) params["_include"] = opts.includes;
  if (opts.revIncludes?.length) params["_revinclude"] = opts.revIncludes;
  return params;
}

export async function searchResource(opts: FhirSearchParams): Promise<unknown> {
  return fhirRequest({ method: "GET", path: resourcePath(opts.resourceType), params: searchQuery(opts) });
}

// ── History ───────────────────────────────────────────────────────────────────

export async function getResourceHistory(
  resourceType: string,
  id: string,
  count?: number,
  since?: string
): Promise<unknown> {
  const params: Record<string, string> = {};
  if (count !== undefined) params["_count"] = String(count);
  if (since) params["_since"] = since;
  return fhirRequest({
    method: "GET",
    path: `${resourcePath(resourceType, id)}/_history`,
    params,
  });
}

export async function getTypeHistory(
  resourceType: string,
  count?: number,
  since?: string
): Promise<unknown> {
  const params: Record<string, string> = {};
  if (count !== undefined) params["_count"] = String(count);
  if (since) params["_since"] = since;
  return fhirRequest({ method: "GET", path: `${resourcePath(resourceType)}/_history`, params });
}

// ── Operations ────────────────────────────────────────────────────────────────

export async function getCapabilityStatement(): Promise<unknown> {
  // Sent with the token like every other call: many servers serve /metadata
  // anonymously, but Smile CDR's /fhir-agent endpoint answers 401 without one.
  return fhirRequest({ method: "GET", path: "/metadata" });
}

export async function executeOperation(
  operation: string,
  resourceType?: string,
  id?: string,
  body?: unknown
): Promise<unknown> {
  if (id !== undefined && resourceType === undefined) {
    throw new Error("An instance-level operation needs resourceType as well as id.");
  }
  const base = resourceType !== undefined ? resourcePath(resourceType, id) : "";
  return fhirRequest({
    method: body !== undefined ? "POST" : "GET",
    path: `${base}/${operationSegment(operation)}`,
    body,
  });
}

export async function executeTransaction(bundle: unknown): Promise<unknown> {
  return fhirRequest({ method: "POST", path: "/", body: bundle });
}

export async function getPatientEverything(
  patientId: string,
  params?: Record<string, string>
): Promise<unknown> {
  return fhirRequest({
    method: "GET",
    path: `${resourcePath("Patient", patientId)}/$everything`,
    params,
  });
}

export async function validateResource(
  resourceType: string,
  body: unknown,
  profile?: string
): Promise<unknown> {
  const params: Record<string, string> = {};
  if (profile) params["profile"] = profile;
  return fhirRequest({
    method: "POST",
    path: `${resourcePath(resourceType)}/$validate`,
    body,
    params,
  });
}
