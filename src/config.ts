import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig, parseDotEnv } from "./config-schema.js";

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

export const config = parseConfig(process.env);
