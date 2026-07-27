import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envFlag, ORB, orbTitle } from "./sense/util.mjs";

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

function requireIntEnv(name) {
  const n = Number(requireEnv(name));
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number`);
  return n;
}

function optionalMs(name, fallback) {
  const n = Number(process.env[name] || fallback);
  return Number.isFinite(n) ? n : fallback;
}

const dataDir = join(ROOT, "data");

export const config = {
  root: ROOT,
  host: requireEnv("COMPANION_HOST"),
  port: requireIntEnv("COMPANION_PORT"),
  baseUrl: requireEnv("OPENAI_BASE_URL"),
  apiKey: process.env.OPENAI_API_KEY ?? "",
  chatModel: requireEnv("OPENAI_CHAT_MODEL"),
  senseIntervalMs: optionalMs("COMPANION_SENSE_INTERVAL_MS", 1500),
  thinkMinMs: optionalMs("COMPANION_THINK_MIN_MS", 8000),
  proactiveMs: optionalMs("COMPANION_PROACTIVE_MS", 45000),
  speakMinMs: optionalMs("COMPANION_SPEAK_MIN_MS", 25000),
  /** How long a balloon stays visible before auto-clear. */
  balloonMs: optionalMs("COMPANION_BALLOON_MS", 10000),
  captureAll: envFlag("COMPANION_CAPTURE_ALL", true),
  typeIdleMs: optionalMs("COMPANION_TYPE_IDLE_MS", 2500),
  typeMaxChars: optionalMs("COMPANION_TYPE_MAX_CHARS", 16000),
  pcIdleMs: optionalMs("COMPANION_PC_IDLE_MS", 60000),
  hotReload: envFlag("COMPANION_HOT_RELOAD", true),
  orbClickThrough: envFlag("COMPANION_ORB_CLICK_THROUGH", true),
  orbX11: envFlag("COMPANION_ORB_X11", true),
  orbTitle: orbTitle(),
  orb: ORB,
  dataDir,
  storePath: join(dataDir, "memory.json"),
  promptPath: join(ROOT, "prompts", "companion.md"),
  publicDir: join(ROOT, "public"),
};

/** Soft port reader (no OPENAI_* required). */
export function readCompanionPort(root = ROOT, fallback = 8770) {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return fallback;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^COMPANION_PORT=(.+)$/);
    if (m) return Number(m[1].trim()) || fallback;
  }
  return fallback;
}
