import type { Express } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoveryUrls } from "./oauth/discovery.js";
import { protectedResourceMetadataPath, protectedResourceMetadataUrl } from "./oauth/metadata.js";

export interface DashboardCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface DashboardReport {
  checkedAt: string;
  ok: boolean;
  checks: DashboardCheck[];
}

interface DashboardOptions {
  publicUrl: string;
  issuer: string;
  jwksUri?: string;
  fetcher?: typeof fetch;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createDashboardProbe(options: DashboardOptions): () => Promise<DashboardReport> {
  const { publicUrl, issuer, jwksUri, fetcher = fetch } = options;
  const origin = new URL(publicUrl).origin;
  let cached: DashboardReport | undefined;
  let inFlight: Promise<DashboardReport> | undefined;

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    return fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(5_000) });
  }

  async function json(url: string): Promise<unknown> {
    const response = await request(url);
    if (response.status !== 200) throw new Error("Unexpected HTTP status");
    return response.json();
  }

  async function check(id: string, label: string, test: () => Promise<boolean>, detail: string): Promise<DashboardCheck> {
    try {
      if (!await test()) throw new Error("Response validation failed");
      return { id, label, ok: true, detail };
    } catch {
      console.error(`[dashboard] check failed: ${id} (request failed, timed out, or returned an unexpected response)`);
      return { id, label, ok: false, detail: "Failed, timed out, or returned an unexpected response. Check server diagnostics." };
    }
  }

  async function run(): Promise<DashboardReport> {
    // Share readiness/discovery requests between related checks in this refresh.
    const readiness = json(`${origin}/readyz`).then(value => ({ value }), () => ({ value: undefined }));
    const discovery = (async () => {
      for (const url of discoveryUrls(issuer)) {
        try {
          const metadata = await json(url);
          if (!record(metadata) || metadata.issuer !== issuer || typeof metadata.jwks_uri !== "string") {
            throw new Error("Invalid issuer metadata");
          }
          return metadata;
        } catch {
          console.error("[dashboard] AIC discovery candidate failed");
        }
      }
      return undefined;
    })();

    const checks = await Promise.all([
      check("landing", "Public landing page", async () => {
        const response = await request(`${origin}/`);
        return response.status === 200 && (response.headers.get("content-type") ?? "").includes("text/html");
      }, "Public page reachable within five seconds over the configured URL."),
      check("health", "Public application health", async () => {
        const value = await json(`${origin}/healthz`);
        return record(value) && value.status === "ok";
      }, "Application is responding."),
      check("ready", "Public readiness endpoint", async () => {
        const { value } = await readiness;
        return record(value) && value.status === "ready" && record(value.oauth) && value.oauth.state === "ready";
      }, "Readiness and OAuth initialization passed."),
      check("fhir", "FHIR connectivity and R4 compatibility", async () => {
        const { value } = await readiness;
        return record(value) && value.status === "ready" && record(value.fhir) && value.fhir.versionMatches === true;
      }, "Readiness fetched the FHIR CapabilityStatement using configured outbound authentication and confirmed R4."),
      ...[protectedResourceMetadataPath(publicUrl), "/.well-known/oauth-protected-resource"].filter((path, index, paths) => paths.indexOf(path) === index).map((path, index) =>
        check(`metadata-${index}`, index === 0 ? "MCP OAuth metadata" : "Root OAuth metadata", async () => {
          const value = await json(`${origin}${path}`);
          return record(value) && value.resource === publicUrl && Array.isArray(value.authorization_servers) && value.authorization_servers.includes(issuer);
        }, "Public metadata identifies the configured MCP resource and issuer.")),
      check("mcp-auth", "MCP authentication enforcement", async () => {
        const response = await request(publicUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const challenge = response.headers.get("www-authenticate") ?? "";
        return response.status === 401 && /Bearer/i.test(challenge) && challenge.includes(protectedResourceMetadataUrl(publicUrl));
      }, "Unauthenticated requests are rejected with HTTP 401 and OAuth discovery metadata."),
      ...["claude-code", "gemini-cli", "mcp-inspector", "vscode"].map(name =>
        check(`cimd-${name}`, `CIMD: ${name}`, async () => {
          const url = `${origin}/cimd/${name}.json`;
          const response = await request(url);
          if (response.status !== 200 || !(response.headers.get("content-type") ?? "").includes("application/json")) return false;
          const text = await response.text();
          if (Buffer.byteLength(text) > 5 * 1024) return false;
          const value: unknown = JSON.parse(text);
          return record(value) && value.client_id === url && value.token_endpoint_auth_method === "none" && Array.isArray(value.redirect_uris) && value.redirect_uris.length > 0;
        }, "Public JSON, no redirects, at most 5 KB, and matching client ID.")),
      check("aic-discovery", "AIC issuer discovery", async () => Boolean(await discovery), "Issuer metadata is reachable and the issuer matches exactly."),
      check("aic-jwks", "AIC signing keys", async () => {
        const metadata = await discovery;
        const url = jwksUri ?? metadata?.jwks_uri;
        if (typeof url !== "string") return false;
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) return false;
        const value = await json(url);
        return record(value) && Array.isArray(value.keys) && value.keys.some(key => record(key) && (key.kty === "RSA" || key.kty === "EC") && typeof key.kid === "string");
      }, "Configured/discovered JWKS endpoint returns signing-key metadata. This does not test a user token."),
    ]);
    return { checkedAt: new Date().toISOString(), ok: checks.every(item => item.ok), checks };
  }

  return () => {
    if (cached && Date.now() - Date.parse(cached.checkedAt) < 30_000) return Promise.resolve(cached);
    if (!inFlight) {
      inFlight = run().then(report => { cached = report; return report; }).finally(() => { inFlight = undefined; });
    }
    return inFlight;
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function registerDashboard(app: Express, options: DashboardOptions, version: string): void {
  const assets = join(__dirname, "../public");
  const template = readFileSync(join(assets, "index.html"), "utf8");
  const html = template.replaceAll("{{PUBLIC_URL}}", escapeHtml(options.publicUrl))
    .replaceAll("{{ORIGIN}}", escapeHtml(new URL(options.publicUrl).origin))
    .replaceAll("{{VERSION}}", escapeHtml(version));
  const probe = createDashboardProbe(options);
  for (const name of ["dashboard.js", "style.css"]) {
    app.get(`/dashboard-assets/${name}`, (_req, res) => res.sendFile(join(assets, name)));
  }
  app.get("/", (_req, res) => {
    res.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.type("html").send(html);
  });
  app.get("/dashboard/status", async (_req, res) => {
    res.set("Cache-Control", "no-store").json(await probe());
  });
}
