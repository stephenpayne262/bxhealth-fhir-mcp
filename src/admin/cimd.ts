import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const CIMD_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_BYTES = 5 * 1024; // AIC refuses larger client metadata documents

type Doc = Record<string, unknown>;

/** Throws an Error with a user-facing message if the document is unusable. */
export function validateCimdDocument(value: unknown): Doc {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Document must be a JSON object");
  const doc = value as Doc;
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) throw new Error("redirect_uris must be a non-empty array");
  for (const uri of uris) {
    let url: URL;
    try {
      if (typeof uri !== "string") throw new Error();
      url = new URL(uri);
    } catch {
      throw new Error("redirect_uris must contain only absolute URLs");
    }
    if (url.hash) throw new Error("redirect_uris must not contain a #fragment");
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("redirect_uris must be http(s) URLs");
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("http redirect_uris are allowed only for localhost");
    }
  }
  for (const forbidden of ["client_secret", "client_secret_expires_at", "jwks", "jwks_uri"]) {
    if (forbidden in doc) throw new Error(`${forbidden} is not allowed: CIMD clients are public clients`);
  }
  if ("client_name" in doc && typeof doc.client_name !== "string") throw new Error("client_name must be a string");
  if ("token_endpoint_auth_method" in doc && doc.token_endpoint_auth_method !== "none") {
    throw new Error('token_endpoint_auth_method must be "none"');
  }
  return doc;
}

/**
 * CIMD documents served at /cimd/<name>.json: the built-in templates from the
 * cimd/ directory plus admin edits and additions. The served client_id is
 * always the document's own URL, whatever the stored JSON says.
 */
export class CimdStore {
  private readonly builtins = new Map<string, Doc>();
  private readonly edits = new Map<string, Doc>();

  constructor(private readonly publicUrl: string, edits: Record<string, Doc>, dir = join(__dirname, "../../cimd")) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -5);
      if (CIMD_NAME.test(name)) this.builtins.set(name, validateCimdDocument(JSON.parse(readFileSync(join(dir, file), "utf8"))));
    }
    for (const [name, doc] of Object.entries(edits)) if (CIMD_NAME.test(name)) this.edits.set(name, doc);
  }

  url(name: string): string {
    return new URL(`/cimd/${name}.json`, this.publicUrl).href;
  }

  get(name: string): Doc | undefined {
    const doc = this.edits.get(name) ?? this.builtins.get(name);
    return doc && { ...doc, client_id: this.url(name) };
  }

  list() {
    const names = [...new Set([...this.builtins.keys(), ...this.edits.keys()])].sort();
    return names.map((name) => ({
      name,
      url: this.url(name),
      builtin: this.builtins.has(name),
      modified: this.edits.has(name),
      document: this.get(name)!,
    }));
  }

  /** Returns the document as it would be stored, or throws. */
  validate(name: string, value: unknown): Doc {
    if (!CIMD_NAME.test(name)) throw new Error("Name must be lowercase letters, digits and hyphens");
    const stored = { ...validateCimdDocument(value), client_id: this.url(name) };
    if (Buffer.byteLength(JSON.stringify(stored)) > MAX_BYTES) throw new Error("Document must be at most 5 KB");
    return stored;
  }

  set(name: string, value: unknown): void {
    this.edits.set(name, this.validate(name, value));
  }

  /** Removes a custom document, or reverts a built-in one to its template. */
  remove(name: string): boolean {
    return this.edits.delete(name);
  }

  edited(): Record<string, Doc> {
    return Object.fromEntries(this.edits);
  }
}
