import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig } from "./config-schema.js";

// Load .env from the project root (one level up from src/ or dist/) into
// process.env, without pulling in a dependency. Values already present in the
// environment win, so an MCP host or shell export can override the file.
function loadDotEnv(): void {
  const projectRoot = resolve(__dirname, "..");

  let contents: string;
  try {
    contents = readFileSync(resolve(projectRoot, ".env"), "utf8");
  } catch {
    return;
  }

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

export const config = parseConfig(process.env);
