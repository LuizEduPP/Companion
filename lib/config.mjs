import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(path) {
  if (!existsSync(path)) {
    throw new Error(`missing .env at ${path} — copy .env.example`);
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(join(ROOT, ".env"));

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required env: ${name}`);
  }
  return value;
}

const dataDir = join(ROOT, "data");

/** The only bind knobs — see AGENTS.md. */
export const BIND = Object.freeze({
  host: "127.0.0.1",
  port: 8770,
});

export const config = Object.freeze({
  root: ROOT,
  host: BIND.host,
  port: BIND.port,
  baseUrl: requireEnv("OPENAI_BASE_URL"),
  apiKey: process.env.OPENAI_API_KEY ?? "",
  chatModel: requireEnv("OPENAI_CHAT_MODEL"),
  /** CLI flag, not product personality. */
  hotReload: process.argv.includes("--hot"),
  dataDir,
  storePath: join(dataDir, "memory.json"),
  promptPath: join(ROOT, "prompts", "companion.md"),
  publicDir: join(ROOT, "public"),
});

export function readCompanionPort() {
  return BIND.port;
}
