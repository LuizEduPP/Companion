import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFlag } from "./sense/util.mjs";

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

function requireFloatEnv(name) {
  const n = Number(requireEnv(name));
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number`);
  return n;
}

const dataDir = join(ROOT, "data");

export const config = Object.freeze({
  root: ROOT,
  host: requireEnv("COMPANION_HOST"),
  port: requireIntEnv("COMPANION_PORT"),
  baseUrl: requireEnv("OPENAI_BASE_URL"),
  apiKey: process.env.OPENAI_API_KEY ?? "",
  chatModel: requireEnv("OPENAI_CHAT_MODEL"),
  chatTemperature: requireFloatEnv("COMPANION_CHAT_TEMPERATURE"),
  chatMaxTokens: requireIntEnv("COMPANION_CHAT_MAX_TOKENS"),
  chatTimeoutMs: requireIntEnv("COMPANION_CHAT_TIMEOUT_MS"),
  senseIntervalMs: requireIntEnv("COMPANION_SENSE_INTERVAL_MS"),
  thinkMinMs: requireIntEnv("COMPANION_THINK_MIN_MS"),
  proactiveMs: requireIntEnv("COMPANION_PROACTIVE_MS"),
  speakMinMs: requireIntEnv("COMPANION_SPEAK_MIN_MS"),
  speakMaxChars: requireIntEnv("COMPANION_SPEAK_MAX_CHARS"),
  balloonMs: requireIntEnv("COMPANION_BALLOON_MS"),
  emotionHoldMs: requireIntEnv("COMPANION_EMOTION_HOLD_MS"),
  drainIntervalMs: requireIntEnv("COMPANION_DRAIN_INTERVAL_MS"),
  bootDelayMs: requireIntEnv("COMPANION_BOOT_DELAY_MS"),
  proactiveTickMs: requireIntEnv("COMPANION_PROACTIVE_TICK_MS"),
  typeIdleMs: requireIntEnv("COMPANION_TYPE_IDLE_MS"),
  typeMaxChars: requireIntEnv("COMPANION_TYPE_MAX_CHARS"),
  pcIdleMs: requireIntEnv("COMPANION_PC_IDLE_MS"),
  episodeCap: requireIntEnv("COMPANION_EPISODE_CAP"),
  recentEpisodesLimit: requireIntEnv("COMPANION_RECENT_EPISODES"),
  knowMinLen: requireIntEnv("COMPANION_KNOW_MIN_LEN"),
  knowTokenMinLen: requireIntEnv("COMPANION_KNOW_TOKEN_MIN_LEN"),
  knowSimilarUnionMin: requireIntEnv("COMPANION_KNOW_SIMILAR_UNION_MIN"),
  knowSimilarOverlapMin: requireIntEnv("COMPANION_KNOW_SIMILAR_OVERLAP_MIN"),
  knowSimilarUnionRatio: requireFloatEnv("COMPANION_KNOW_SIMILAR_UNION_RATIO"),
  knowSimilarOverlapRatio: requireFloatEnv("COMPANION_KNOW_SIMILAR_OVERLAP_RATIO"),
  shTimeoutMs: requireIntEnv("COMPANION_SH_TIMEOUT_MS"),
  shMaxBuffer: requireIntEnv("COMPANION_SH_MAX_BUFFER"),
  shQuickMs: requireIntEnv("COMPANION_SH_QUICK_MS"),
  shMediumMs: requireIntEnv("COMPANION_SH_MEDIUM_MS"),
  shFocusMs: requireIntEnv("COMPANION_SH_FOCUS_MS"),
  shSlowMs: requireIntEnv("COMPANION_SH_SLOW_MS"),
  kwinSettleMs: requireIntEnv("COMPANION_KWIN_SETTLE_MS"),
  captureAll: requireFlag("COMPANION_CAPTURE_ALL"),
  hotReload: requireFlag("COMPANION_HOT_RELOAD"),
  orbX11: requireFlag("COMPANION_ORB_X11"),
  orbClickThrough: requireFlag("COMPANION_ORB_CLICK_THROUGH"),
  orbTitle: requireEnv("COMPANION_ORB_TITLE"),
  locale: requireEnv("COMPANION_LOCALE"),
  userName: String(process.env.COMPANION_USER_NAME || "").trim(),
  watchDirs: String(process.env.COMPANION_WATCH_DIRS || "")
    .split(/[,:;]/)
    .map((s) => s.trim())
    .filter(Boolean),
  orb: Object.freeze({
    width: requireIntEnv("COMPANION_ORB_WIDTH"),
    height: requireIntEnv("COMPANION_ORB_HEIGHT"),
    balloonHeight: requireIntEnv("COMPANION_ORB_BALLOON_HEIGHT"),
  }),
  dataDir,
  storePath: join(dataDir, "memory.json"),
  promptPath: join(ROOT, "prompts", "companion.md"),
  publicDir: join(ROOT, "public"),
});

/** Soft port reader for orb (loads .env lines without OPENAI_*). */
export function readCompanionPort(root = ROOT) {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) {
    throw new Error(`missing .env at ${envPath}`);
  }
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^COMPANION_PORT=(.+)$/);
    if (m) {
      const n = Number(m[1].trim());
      if (!Number.isFinite(n)) throw new Error("COMPANION_PORT must be a number");
      return n;
    }
  }
  throw new Error("COMPANION_PORT missing in .env");
}
