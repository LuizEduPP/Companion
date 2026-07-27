import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const OFF_VALUES = new Set(["0", "false", "no", "off"]);

function requireEnvInt(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    throw new Error(`missing required env: ${name}`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number`);
  return n;
}

function requireEnvFloat(name) {
  const n = Number(
    (() => {
      const raw = process.env[name];
      if (raw === undefined || raw === "") {
        throw new Error(`missing required env: ${name}`);
      }
      return raw;
    })(),
  );
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number`);
  return n;
}

/** Capture / display / prompt budgets — all from env (lazy, after dotenv). */
export const LIMITS = Object.freeze({
  get clipboardRaw() {
    return requireEnvInt("COMPANION_LIMIT_CLIPBOARD_RAW");
  },
  get clipboardStored() {
    return requireEnvInt("COMPANION_LIMIT_CLIPBOARD_STORED");
  },
  get typed() {
    return requireEnvInt("COMPANION_TYPE_MAX_CHARS");
  },
  get a11yValue() {
    return requireEnvInt("COMPANION_LIMIT_A11Y_VALUE");
  },
  get a11ySelection() {
    return requireEnvInt("COMPANION_LIMIT_A11Y_SELECTION");
  },
  get a11yName() {
    return requireEnvInt("COMPANION_LIMIT_A11Y_NAME");
  },
  get a11yRole() {
    return requireEnvInt("COMPANION_LIMIT_A11Y_ROLE");
  },
  get speak() {
    return requireEnvInt("COMPANION_LIMIT_SPEAK");
  },
  get modelContent() {
    return requireEnvInt("COMPANION_LIMIT_MODEL_CONTENT");
  },
  get modelTyped() {
    return requireEnvInt("COMPANION_LIMIT_MODEL_TYPED");
  },
  get episodeText() {
    return requireEnvInt("COMPANION_LIMIT_EPISODE_TEXT");
  },
  get episodeSelection() {
    return requireEnvInt("COMPANION_LIMIT_EPISODE_SELECTION");
  },
  get episodeSelectionLong() {
    return requireEnvInt("COMPANION_LIMIT_EPISODE_SELECTION_LONG");
  },
  get windowApp() {
    return requireEnvInt("COMPANION_LIMIT_WINDOW_APP");
  },
  get windowTitle() {
    return requireEnvInt("COMPANION_LIMIT_WINDOW_TITLE");
  },
  get windowsMax() {
    return requireEnvInt("COMPANION_LIMIT_WINDOWS_MAX");
  },
  get openFiles() {
    return requireEnvInt("COMPANION_LIMIT_OPEN_FILES");
  },
  get recentFiles() {
    return requireEnvInt("COMPANION_LIMIT_RECENT_FILES");
  },
  get url() {
    return requireEnvInt("COMPANION_LIMIT_URL");
  },
  get path() {
    return requireEnvInt("COMPANION_LIMIT_PATH");
  },
  get project() {
    return requireEnvInt("COMPANION_LIMIT_PROJECT");
  },
  get fileHint() {
    return requireEnvInt("COMPANION_LIMIT_FILE_HINT");
  },
  get notes() {
    return requireEnvInt("COMPANION_LIMIT_NOTES");
  },
  get pageTitle() {
    return requireEnvInt("COMPANION_LIMIT_PAGE_TITLE");
  },
  get fileName() {
    return requireEnvInt("COMPANION_LIMIT_FILE_NAME");
  },
  get contentMinLen() {
    return requireEnvInt("COMPANION_LIMIT_CONTENT_MIN_LEN");
  },
  get recentFilesScanPerDir() {
    return requireEnvInt("COMPANION_LIMIT_RECENT_SCAN_PER_DIR");
  },
  get recentFilesHours() {
    return requireEnvInt("COMPANION_LIMIT_RECENT_FILES_HOURS");
  },
  get codeCrumbMax() {
    return requireEnvInt("COMPANION_LIMIT_CODE_CRUMB_MAX");
  },
  get fingerprintTyped() {
    return requireEnvInt("COMPANION_LIMIT_FINGERPRINT_TYPED");
  },
  get knowsCap() {
    return requireEnvInt("COMPANION_LIMIT_KNOWS_CAP");
  },
  get promptKnows() {
    return requireEnvInt("COMPANION_LIMIT_PROMPT_KNOWS");
  },
  get promptEpisodes() {
    return requireEnvInt("COMPANION_LIMIT_PROMPT_EPISODES");
  },
  get promptGaps() {
    return requireEnvInt("COMPANION_LIMIT_PROMPT_GAPS");
  },
  get logSnippet() {
    return requireEnvInt("COMPANION_LIMIT_LOG_SNIPPET");
  },
  get statusTyped() {
    return requireEnvInt("COMPANION_LIMIT_STATUS_TYPED");
  },
  get statusList() {
    return requireEnvInt("COMPANION_LIMIT_STATUS_LIST");
  },
  get recentActivity() {
    return requireEnvInt("COMPANION_LIMIT_RECENT_ACTIVITY");
  },
});

export const UNKNOWN_APP = "unknown";
export const COMPANION_APP = "companion";
export const FOCUS_JSON_MARK = "COMPANION_FOCUS_JSON:";
export const KWIN_SCRIPT_NAME = "companion-focus";

export const EMPTY_FOCUS = Object.freeze({
  app: UNKNOWN_APP,
  title: UNKNOWN_APP,
  skip: false,
  pid: null,
});

/** Project folder name used to recognize self-path clipboard noise. */
function selfPathMark() {
  const fromEnv = String(process.env.COMPANION_SELF_PATH_MARK || "").trim();
  if (fromEnv) return fromEnv;
  // Derive from this package location (…/032-companion/lib/sense/util.mjs).
  const here = dirnameFromMeta();
  return basename(join(here, "..", ".."));
}

function dirnameFromMeta() {
  return dirname(fileURLToPath(import.meta.url));
}

/** Shell timeout presets from env (after dotenv). */
export const SH_MS = Object.freeze({
  get default() {
    return requireEnvInt("COMPANION_SH_TIMEOUT_MS");
  },
  get quick() {
    return requireEnvInt("COMPANION_SH_QUICK_MS");
  },
  get medium() {
    return requireEnvInt("COMPANION_SH_MEDIUM_MS");
  },
  get focus() {
    return requireEnvInt("COMPANION_SH_FOCUS_MS");
  },
  get slow() {
    return requireEnvInt("COMPANION_SH_SLOW_MS");
  },
  get kwinSettle() {
    return requireEnvInt("COMPANION_KWIN_SETTLE_MS");
  },
});

/** Lazy — call after config/dotenv loaded. */
export function orbTitle() {
  const raw = String(process.env.COMPANION_ORB_TITLE || "").trim();
  if (!raw) throw new Error("missing required env: COMPANION_ORB_TITLE");
  return raw;
}

/** Lazy orb geometry from env (after dotenv). */
export function orbGeometry() {
  return Object.freeze({
    width: requireEnvInt("COMPANION_ORB_WIDTH"),
    height: requireEnvInt("COMPANION_ORB_HEIGHT"),
    balloonHeight: requireEnvInt("COMPANION_ORB_BALLOON_HEIGHT"),
  });
}

export function envFlag(name, defaultOn = true) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultOn;
  return !OFF_VALUES.has(String(v).toLowerCase());
}

/** Fail-fast boolean from env (must be set). */
export function requireFlag(name) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`missing required env: ${name}`);
  }
  return !OFF_VALUES.has(String(v).toLowerCase());
}

export function captureEnabled(flagName, masterOn) {
  if (!masterOn) return false;
  return envFlag(flagName, true);
}

export function sensePlatform() {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

export async function sh(cmd, args, opts = {}) {
  const timeout = opts.timeout ?? requireEnvInt("COMPANION_SH_TIMEOUT_MS");
  const maxBuffer = opts.maxBuffer ?? requireEnvInt("COMPANION_SH_MAX_BUFFER");
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout,
      maxBuffer,
      env: opts.env ?? process.env,
      ...opts,
    });
    return {
      ok: true,
      stdout: String(stdout || "").trim(),
      stderr: String(stderr || ""),
    };
  } catch (err) {
    return { ok: false, stdout: "", stderr: err.message, err };
  }
}

export function isOrb(app, title) {
  const t = String(title || "");
  const a = String(app || "").toLowerCase();
  if (t.includes(orbTitle())) return true;
  if (a === COMPANION_APP) return true;
  return false;
}

export function packFocus({ app, title, pid = null, desktopFile = "" } = {}) {
  const a = String(app || "").trim();
  const t = String(title || "").trim();
  if (!a && !t) return null;
  if (isOrb(a, t)) {
    return {
      app: COMPANION_APP,
      title: t || orbTitle(),
      pid: pid ? Number(pid) : null,
      desktopFile: "",
      skip: true,
    };
  }
  return {
    app: a || t || UNKNOWN_APP,
    title: t || a,
    pid: pid ? Number(pid) : null,
    desktopFile: String(desktopFile || "").trim(),
    skip: false,
  };
}

export function pickApp(...candidates) {
  for (const c of candidates) {
    const s = String(c ?? "").trim();
    if (s) return s;
  }
  return "";
}

export function trimWindow(w) {
  return {
    app: String(w?.app || "").slice(0, LIMITS.windowApp),
    title: String(w?.title || "").slice(0, LIMITS.windowTitle),
    pid: w?.pid == null || w?.pid === "" ? null : Number(w.pid) || null,
  };
}

export function packWindows(list, max = LIMITS.windowsMax) {
  return (list || [])
    .map(trimWindow)
    .filter((w) => w.app || w.title)
    .slice(0, max);
}

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required env: ${name}`);
  }
  return value;
}

/** Compile a required env regex. Companion of COMPANION_RE_*_FLAGS (may be empty). */
function requireEnvRe(name) {
  const source = requireEnv(name);
  const flagsKey = `${name}_FLAGS`;
  if (process.env[flagsKey] === undefined) {
    throw new Error(`missing required env: ${flagsKey}`);
  }
  const flags = process.env[flagsKey];
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new Error(`invalid regex env ${name}: ${err.message}`);
  }
}

let _re = null;
function re() {
  if (_re) return _re;
  _re = Object.freeze({
    redactToken: requireEnvRe("COMPANION_RE_REDACT_TOKEN"),
    redactSecretKv: requireEnvRe("COMPANION_RE_REDACT_SECRET_KV"),
    modelIdBare: requireEnvRe("COMPANION_RE_MODEL_ID_BARE"),
    modelIdEmbedded: requireEnvRe("COMPANION_RE_MODEL_ID_EMBEDDED"),
    // Unified infra matcher (logs + wire JSON + decision dumps + env leaks + store).
    infra: requireEnvRe("COMPANION_RE_INFRA"),
    absPath: requireEnvRe("COMPANION_RE_ABS_PATH"),
    silenceObject: requireEnvRe("COMPANION_RE_SILENCE_OBJECT"),
    codeCrumbChars: requireEnvRe("COMPANION_RE_CODE_CRUMB_CHARS"),
    codeCrumbMark: requireEnvRe("COMPANION_RE_CODE_CRUMB_MARK"),
    hasWhitespace: requireEnvRe("COMPANION_RE_HAS_WHITESPACE"),
  });
  return _re;
}

export function redactSecrets(text) {
  let s = String(text ?? "");
  const r = re();
  s = s.replace(r.redactToken, "[redacted-token]");
  s = s.replace(r.redactSecretKv, "$1=[redacted]");
  return s;
}

/**
 * org/model-revision ids (OPENAI_CHAT_MODEL). Pattern from env; requires a digit.
 */
export function looksLikeModelId(text) {
  const x = String(text ?? "").trim();
  if (!x || x.startsWith("/")) return false;
  return re().modelIdBare.test(x);
}

/** True when text is or embeds a model id (configured chat model or env pattern). */
export function mentionsModelId(text) {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  const chatModel = String(process.env.OPENAI_CHAT_MODEL || "").trim();
  if (chatModel && t.includes(chatModel)) return true;
  if (looksLikeModelId(t.trim())) return true;
  return re().modelIdEmbedded.test(t);
}

/**
 * Companion/LLM plumbing noise — one env regex + structural checks (path mark, model id, line ratio).
 */
export function isInfraNoise(text) {
  const t = String(text ?? "");
  if (!t.trim()) return true;
  const r = re();
  if (r.infra.test(t)) return true;
  const pathOnly = t.trim();
  const mark = selfPathMark();
  if (mark && r.absPath.test(pathOnly) && pathOnly.includes(`/${mark}`)) {
    return true;
  }
  if (mentionsModelId(t)) return true;
  const minLines = requireEnvInt("COMPANION_INFRA_NOISE_MIN_LINES");
  const ratio = requireEnvFloat("COMPANION_INFRA_NOISE_RATIO");
  const lines = t.split("\n").filter((l) => l.trim());
  if (lines.length >= minLines) {
    const noisy = lines.filter((l) => r.infra.test(l)).length;
    if (noisy / lines.length >= ratio) return true;
  }
  return false;
}

/** Human clipboard/selection text safe for the model (null = drop). */
export function contentForModel(text, maxLen = LIMITS.modelContent) {
  const s = String(text || "").trim();
  if (!s || s.length < LIMITS.contentMinLen) return null;
  if (isInfraNoise(s)) return null;
  if (re().silenceObject.test(s)) return null;
  const crumbMax = LIMITS.codeCrumbMax;
  const r = re();
  if (
    s.length <= crumbMax &&
    r.codeCrumbChars.test(s) &&
    r.codeCrumbMark.test(s) &&
    !r.hasWhitespace.test(s)
  ) {
    return null;
  }
  return s.slice(0, maxLen);
}

/** Shared recent-files scan for watch dirs (no fixed home folder catalog). */
export async function listRecentFiles(dirs, limit = LIMITS.recentFiles) {
  const found = [];
  const cutoff =
    Date.now() - 1000 * 60 * 60 * LIMITS.recentFilesHours;
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const ent of entries.slice(0, LIMITS.recentFilesScanPerDir)) {
        if (!ent.isFile()) continue;
        const p = join(dir, ent.name);
        try {
          const st = await stat(p);
          if (st.mtimeMs >= cutoff) found.push({ path: p, mtime: st.mtimeMs });
        } catch {
          /* ignore unreadable entry */
        }
      }
    } catch {
      /* ignore unreadable dir */
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, limit).map((f) => f.path);
}
