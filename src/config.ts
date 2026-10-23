import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig, parseDotEnv } from "./config-schema.js";
import { defaultDataDir, loadOverrides } from "./admin/store.js";
import { SETTING_KEYS } from "./admin/settings.js";

// Load .env from the project root (one level up from src/ or dist/) into
// process.env, without pulling in a dependency. Values already present in the
// environment win, so an MCP host or shell export can override the file.
function loadDotEnv(): void {
  let contents: string;
  try {
    contents = readFileSync(resolve(__dirname, "..", ".env"), "utf8");
  } catch {
    return;
  }

  for (const [key, value] of Object.entries(parseDotEnv(contents))) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

// Settings saved in the admin console win over the environment and .env.
// Only keys the console can edit are applied, so the file can never change
// the admin login or the transport.
export const dataDir = defaultDataDir(process.env);
for (const [key, value] of Object.entries(loadOverrides(dataDir).settings)) {
  if (!SETTING_KEYS.has(key)) continue;
  if (value === "") delete process.env[key];
  else process.env[key] = value;
}

export const config = parseConfig(process.env);
