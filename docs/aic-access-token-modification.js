/*
 * OAuth2 Access Token Modification script for PingOne AIC (AM), as used with
 * this MCP server. Setup and context: aic-setup.md, section 3.
 *
 * For MCP clients it sets:
 * - `aud` to the requested RFC 8707 `resource`, if it is in allowedResources.
 * - `patient` to the member's FHIR Patient id: the `fhirid` property the login
 *   journey puts on the session, else the identity's fr-attr-istr1. This
 *   server limits every call to that patient and refuses tokens without it.
 *
 * MCP tokens are tied to the member's AIC session: a refresh for an MCP
 * resource without a live session is refused, so the client signs in again
 * (re-running the journey) instead of getting a token with no patient.
 *
 * It also carries the SMART launch context and the refresh rules the
 * patient-facing FHIR apps use.
 */

var allowedResources = ["http://localhost:3000/mcp"];
var accessTokenAndResponseFields = ["launch", "impersonator"];
var accessTokenResponseOnlyFields = [
  "encounter",
  "client",
  "fhirContext",
  "intent",
  "smart_style_url",
  "tenant"
];

function logError(context, error) {
  var message = error && error.message ? error.message : String(error);
  logger.error("OAuth2 access-token modification - " + context + ": " + message);
}

function firstValue(values) {
  if (!values) {
    return null;
  }

  if (typeof values.get === "function") {
    return values.size() > 0 ? String(values.get(0)) : null;
  }

  return values.length > 0 ? String(values[0]) : null;
}

function requestValue(requestParams, name) {
  return requestParams ? firstValue(requestParams.get(name)) : null;
}

function isRefresh(requestParams) {
  return requestValue(requestParams, "grant_type") === "refresh_token";
}

/** The token is for this MCP server: the client asked for an allowed resource. */
function mcpResource(requestParams) {
  var resource = requestValue(requestParams, "resource");
  return resource && allowedResources.indexOf(resource) !== -1 ? resource : null;
}

function setPatient(patient) {
  accessToken.setField("patient", patient);
  accessToken.addExtraData("patient", patient);
}

function applySessionClaims() {
  if (!session) {
    return;
  }

  var host = session.getProperty("Host");
  if (host) {
    accessToken.setField("ip_address", host);
  }

  for (var i = 0; i < accessTokenAndResponseFields.length; i++) {
    var field = accessTokenAndResponseFields[i];
    var value = session.getProperty(field);
    if (value) {
      accessToken.setField(field, value);
      accessToken.addExtraData(field, value);
    }
  }

  for (var j = 0; j < accessTokenResponseOnlyFields.length; j++) {
    var responseField = accessTokenResponseOnlyFields[j];
    var responseValue = session.getProperty(responseField);
    if (responseValue) {
      accessToken.addExtraData(responseField, responseValue);
    }
  }
}

function applyPatient(requestParams) {
  if (!session && isRefresh(requestParams) && mcpResource(requestParams)) {
    // Without the session there is no fhirid, and the MCP server refuses a
    // token without a patient. Refuse the refresh so the client signs in again.
    throw new Error("KillRefreshTokenNow");
  }

  var fhirId = session ? session.getProperty("fhirid") : null;
  if (!fhirId && identity && identity.exists()) {
    fhirId = firstValue(identity.getAttributeValues("fr-attr-istr1"));
  }
  if (fhirId) {
    setPatient(String(fhirId));
  }
}

function applyMcpAudience(requestParams) {
  var resource = mcpResource(requestParams);
  if (resource) {
    accessToken.setField("aud", resource);
  }
}

function enforceRefreshTokenRules(requestParams) {
  if (!isRefresh(requestParams)) {
    return;
  }

  var scope = requestValue(requestParams, "scope") || "";
  if (scope.indexOf("offline_access") !== -1) {
    return;
  }

  if (scope.indexOf("online_access") !== -1 && !session) {
    throw new Error("KillRefreshTokenNow");
  }
}

function runSafely(context, operation) {
  try {
    operation();
  } catch (error) {
    logError(context, error);
    if (error && error.message === "KillRefreshTokenNow") {
      throw error;
    }
  }
}

try {
  var requestParams = requestProperties.get("requestParams");

  runSafely("session and SMART claims", applySessionClaims);
  runSafely("patient", function () {
    applyPatient(requestParams);
  });
  runSafely("MCP audience", function () {
    applyMcpAudience(requestParams);
  });
  runSafely("refresh-token rules", function () {
    enforceRefreshTokenRules(requestParams);
  });
} catch (error) {
  logError("script", error);
  throw error;
}
