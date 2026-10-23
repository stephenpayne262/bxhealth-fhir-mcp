import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Admin overrides persisted as one JSON file: env-style setting overrides
 * (applied over the environment at startup) and CIMD document edits (served
 * live). An empty-string setting means "unset this variable".
 */
export interface Overrides {
  version: 1;
  settings: Record<string, string>;
  cimd: Record<string, Record<string, unknown>>;
}

export const emptyOverrides = (): Overrides => ({ version: 1, settings: {}, cimd: {} });

export function defaultDataDir(env: Record<string, string | undefined>): string {
  return env.MCP_DATA_DIR?.trim() || join(tmpdir(), "bxhealth-fhir-mcp");
}

const fileIn = (dir: string) => join(dir, "admin-overrides.json");

export function loadOverrides(dir: string): Overrides {
  let raw: string;
  try {
    raw = readFileSync(fileIn(dir), "utf8");
  } catch {
    return emptyOverrides();
  }
  try {
    const data = JSON.parse(raw) as Partial<Overrides>;
    const settings: Record<string, string> = {};
    for (const [k, v] of Object.entries(data.settings ?? {})) if (typeof v === "string") settings[k] = v;
    const cimd: Overrides["cimd"] = {};
    for (const [k, v] of Object.entries(data.cimd ?? {})) {
      if (v && typeof v === "object" && !Array.isArray(v)) cimd[k] = v as Record<string, unknown>;
    }
    return { version: 1, settings, cimd };
  } catch {
    console.error("[admin] ignoring unreadable admin-overrides.json");
    return emptyOverrides();
  }
}

export function saveOverrides(dir: string, overrides: Overrides): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = fileIn(dir);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(overrides, null, 2), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, target);
}
