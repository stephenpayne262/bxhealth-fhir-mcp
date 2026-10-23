import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { join } from "node:path";
import { parseConfig } from "../config-schema.js";
import { CimdStore } from "./cimd.js";
import { SECRET_KEYS, SETTING_KEYS, SETTINGS } from "./settings.js";
import { loadOverrides, saveOverrides } from "./store.js";

export interface AdminOptions {
  username: string;
  password: string;
  publicUrl: string;
  dataDir: string;
  cimd: CimdStore;
  /** Called after a settings change is saved; the default exits so the supervisor restarts the process. */
  restart?: () => void;
}

const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_MAX_MS = 8 * 60 * 60_000;
const LOCKOUT_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;

const digest = (value: string) => createHash("sha256").update(value).digest();

interface Session {
  csrf: string;
  created: number;
  seen: number;
}

export function registerAdmin(app: Express, options: AdminOptions): void {
  const { cimd, dataDir } = options;
  const origin = new URL(options.publicUrl).origin;
  const secureCookie = options.publicUrl.startsWith("https:");
  const cookieName = secureCookie ? "__Host-admin_session" : "admin_session";
  const sessions = new Map<string, Session>();
  const expectedUser = digest(options.username);
  const expectedPass = digest(options.password);
  const restart = options.restart ?? (() => setTimeout(() => process.exit(0), 750));
  let failures: number[] = [];

  const assets = join(__dirname, "../../public");
  const noStore = (res: Response) => res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });

  app.get("/admin", (_req, res) => {
    noStore(res).set(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
    );
    res.sendFile(join(assets, "admin.html"));
  });
  for (const name of ["admin.js", "admin.css"]) {
    app.get(`/admin-assets/${name}`, (_req, res) => res.sendFile(join(assets, name)));
  }

  const api = express.Router();
  api.use((req, res, next) => {
    noStore(res);
    // Browsers send Origin on every cross-site write; reject any that is not ours.
    const sent = req.get("origin");
    if (req.method !== "GET" && sent && sent !== origin) return void res.status(403).json({ error: "Forbidden" });
    next();
  });
  api.use(express.json({ limit: "256kb" }));

  function sessionFrom(req: Request): Session | undefined {
    const match = (req.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${cookieName}=`));
    const id = match?.slice(cookieName.length + 1);
    const session = id ? sessions.get(id) : undefined;
    if (!id || !session) return undefined;
    const now = Date.now();
    if (now - session.seen > SESSION_IDLE_MS || now - session.created > SESSION_MAX_MS) {
      sessions.delete(id);
      return undefined;
    }
    session.seen = now;
    return session;
  }

  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    const session = sessionFrom(req);
    if (!session) return void res.status(401).json({ error: "Not signed in" });
    if (req.method !== "GET") {
      const sent = req.get("x-csrf-token") ?? "";
      const a = digest(sent);
      const b = digest(session.csrf);
      if (!timingSafeEqual(a, b)) return void res.status(403).json({ error: "Forbidden" });
    }
    next();
  };

  api.post("/login", (req, res) => {
    const now = Date.now();
    failures = failures.filter((t) => now - t < LOCKOUT_WINDOW_MS);
    if (failures.length >= MAX_FAILURES) {
      return void res.status(429).set("Retry-After", String(Math.ceil(LOCKOUT_WINDOW_MS / 1000))).json({ error: "Too many attempts. Try again later." });
    }
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    const userOk = timingSafeEqual(digest(typeof username === "string" ? username : ""), expectedUser);
    const passOk = timingSafeEqual(digest(typeof password === "string" ? password : ""), expectedPass);
    if (!(userOk && passOk)) {
      failures.push(now);
      console.error("[admin] failed login");
      return void res.status(401).json({ error: "Invalid username or password" });
    }
    const id = randomBytes(32).toString("hex");
    const csrf = randomBytes(32).toString("hex");
    sessions.set(id, { csrf, created: now, seen: now });
    res.cookie(cookieName, id, { httpOnly: true, secure: secureCookie, sameSite: "strict", path: "/", maxAge: SESSION_MAX_MS });
    console.error("[admin] login");
    res.json({ csrf });
  });

  api.post("/logout", requireSession, (req, res) => {
    const id = (req.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (id) sessions.delete(id);
    res.clearCookie(cookieName, { path: "/" });
    res.json({ ok: true });
  });

  // Lets the page resume after a reload without asking for the password again.
  api.get("/session", (req, res) => {
    const session = sessionFrom(req);
    if (!session) return void res.status(401).json({ error: "Not signed in" });
    res.json({ csrf: session.csrf });
  });

  api.get("/settings", requireSession, (_req, res) => {
    res.json({
      settings: SETTINGS.map((s) => ({
        key: s.key,
        group: s.group,
        description: s.description,
        secret: Boolean(s.secret),
        // Secrets are write-only: report only whether one is set.
        value: s.secret ? "" : process.env[s.key] ?? "",
        isSet: Boolean(process.env[s.key]),
      })),
    });
  });

  /** Validates and persists setting changes. Returns an error string, or whether a restart is needed. */
  function applySettings(values: Record<string, unknown>): { error: string } | { changed: boolean } {
    const merged: Record<string, string | undefined> = { ...process.env };
    const overrides = loadOverrides(dataDir);
    let changed = false;
    for (const [key, raw] of Object.entries(values)) {
      if (!SETTING_KEYS.has(key)) return { error: `Unknown setting ${key}` };
      if (typeof raw !== "string") return { error: `${key} must be a string` };
      const value = raw.trim();
      if (SECRET_KEYS.has(key) && value === "") continue; // blank secret keeps the current one
      if (value === (process.env[key] ?? "")) continue;
      if (/[\r\n]/.test(value)) return { error: `${key} must be a single line` };
      overrides.settings[key] = value;
      if (value === "") delete merged[key];
      else merged[key] = value;
      changed = true;
    }
    if (!changed) return { changed: false };
    try {
      parseConfig(merged);
    } catch (error) {
      return { error: (error as Error).message.replace(/\nCopy \.env\.example.*$/s, "") };
    }
    saveOverrides(dataDir, overrides);
    return { changed: true };
  }

  const finishSettings = (res: Response, result: ReturnType<typeof applySettings>, extra: object = {}) => {
    if ("error" in result) return void res.status(400).json({ error: result.error });
    console.error(`[admin] settings ${result.changed ? "saved; restarting" : "unchanged"}`);
    res.json({ ...extra, restarting: result.changed });
    if (result.changed) restart();
  };

  api.put("/settings", requireSession, (req, res) => {
    const values = req.body?.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) return void res.status(400).json({ error: "values must be an object" });
    finishSettings(res, applySettings(values));
  });

  api.get("/export", requireSession, (_req, res) => {
    const settings: Record<string, string> = {};
    for (const s of SETTINGS) if (!s.secret && process.env[s.key]) settings[s.key] = process.env[s.key]!;
    res
      .set("Content-Disposition", 'attachment; filename="bxhealth-fhir-mcp-settings.json"')
      .json({
        version: 1,
        exportedAt: new Date().toISOString(),
        note: "Secrets are never exported; omit them on import to keep the current values.",
        settings,
        cimd: Object.fromEntries(cimd.list().map((d) => [d.name, d.document])),
      });
  });

  api.post("/import", requireSession, (req, res) => {
    const { version, settings = {}, cimd: docs = {} } = req.body ?? {};
    if (version !== 1) return void res.status(400).json({ error: "Unsupported or missing version (expected 1)" });
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return void res.status(400).json({ error: "settings must be an object" });
    if (typeof docs !== "object" || docs === null || Array.isArray(docs)) return void res.status(400).json({ error: "cimd must be an object" });
    // Validate every CIMD document before applying anything.
    try {
      for (const [name, doc] of Object.entries(docs)) cimd.validate(name, doc);
    } catch (error) {
      return void res.status(400).json({ error: `cimd: ${(error as Error).message}` });
    }
    const result = applySettings(settings);
    if ("error" in result) return void res.status(400).json({ error: result.error });
    for (const [name, doc] of Object.entries(docs)) cimd.set(name, doc);
    persistCimd();
    finishSettings(res, result, { cimdImported: Object.keys(docs).length });
  });

  function persistCimd(): void {
    const overrides = loadOverrides(dataDir);
    overrides.cimd = cimd.edited();
    saveOverrides(dataDir, overrides);
  }

  api.get("/cimd", requireSession, (_req, res) => res.json({ documents: cimd.list() }));

  api.put("/cimd/:name", requireSession, (req, res) => {
    const name = String(req.params.name);
    try {
      cimd.set(name, req.body?.document);
    } catch (error) {
      return void res.status(400).json({ error: (error as Error).message });
    }
    persistCimd();
    console.error(`[admin] cimd document saved: ${name}`);
    res.json({ url: cimd.url(name) });
  });

  api.delete("/cimd/:name", requireSession, (req, res) => {
    const name = String(req.params.name);
    if (!cimd.remove(name)) return void res.status(404).json({ error: "No edited or custom document with that name" });
    persistCimd();
    console.error(`[admin] cimd document removed: ${name}`);
    res.json({ ok: true });
  });

  api.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use("/admin/api", api);
}
