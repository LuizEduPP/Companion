import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Named capture / display limits — single source for sense + brain + store. */
export const LIMITS = Object.freeze({
  clipboardRaw: 16000,
  clipboardStored: 8000,
  typed: 16000,
  a11yValue: 8000,
  a11ySelection: 8000,
  a11yName: 200,
  a11yRole: 120,
  speak: 160,
  modelContent: 500,
  modelTyped: 800,
  episodeText: 280,
  episodeSelection: 200,
  episodeSelectionLong: 500,
  windowApp: 80,
  windowTitle: 160,
  windowsMax: 12,
  openFiles: 16,
  recentFiles: 12,
  url: 500,
  path: 260,
  project: 80,
  fileHint: 120,
  notes: 800,
  pageTitle: 160,
  fileName: 160,
});

export const ORB = Object.freeze({
  width: 240,
  height: 180,
  balloonHeight: 72,
  defaultTitle: "Companion Orb",
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

const OFF_VALUES = new Set(["0", "false", "no", "off"]);

/** Lazy — callers import config (dotenv) before reading title. */
export function orbTitle() {
  const raw = String(process.env.COMPANION_ORB_TITLE || ORB.defaultTitle).trim();
  return raw || ORB.defaultTitle;
}

export function envFlag(name, defaultOn = true) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultOn;
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
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: opts.timeout ?? 8000,
      maxBuffer: opts.maxBuffer ?? 1024 * 1024,
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

export function redactSecrets(text) {
  let s = String(text ?? "");
  s = s.replace(
    /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
    "[redacted-token]",
  );
  s = s.replace(
    /\b([A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key)[A-Za-z0-9_]*)\s*[:=]\s*\S+/gi,
    "$1=[redacted]",
  );
  return s;
}

/**
 * Companion/LLM/hot-reload plumbing — must not enter memory or the think payload.
 */
export function isInfraNoise(text) {
  const t = String(text ?? "");
  if (!t.trim()) return true;
  if (
    /\[(?:hot|brain|sense)\]|companion:think-llm|think JSON parse failed|companion (?:brain|sense|hot)|watching public\/ for orb|companion sense →|OPENAI_|COMPANION_/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\/companion\//i.test(t) ||
    /\/companion\/(lib|public|data|prompts|orb)\//i.test(t)
  ) {
    return true;
  }
  if (/"episodes"\s*:/.test(t) && /"knows"\s*:/.test(t)) return true;
  if (/"type"\s*:\s*"pc_(focus|typed|a11y|clipboard|windows|selection)"/.test(t)) {
    return true;
  }
  if (/pc_selection|pc_clipboard|project_guess/.test(t) && /\\n\s*\{/.test(t)) {
    return true;
  }
  const lines = t.split(/\n/).filter((l) => l.trim());
  if (lines.length >= 3) {
    const noisy = lines.filter((l) =>
      /\[(?:hot|brain|sense)\]|think JSON|companion /i.test(l),
    ).length;
    if (noisy / lines.length >= 0.4) return true;
  }
  return false;
}

/** Human clipboard/selection text safe for the model (null = drop). */
export function contentForModel(text, maxLen = LIMITS.modelContent) {
  const s = String(text || "").trim();
  if (!s || s.length < 8) return null;
  if (isInfraNoise(s)) return null;
  if (/^\s*\{[\s\S]*"silence"\s*:/.test(s)) return null;
  if (
    /^[\\"'`{}\[\]:,\s\w.-]{1,24}$/.test(s) &&
    /[\\"'{}[\],]/.test(s) &&
    !/\s/.test(s)
  ) {
    return null;
  }
  return s.slice(0, maxLen);
}

/** Shared recent-files scan for watch dirs (no fixed home folder catalog). */
export async function listRecentFiles(dirs, limit = LIMITS.recentFiles) {
  const found = [];
  const cutoff = Date.now() - 1000 * 60 * 60 * 24;
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const ent of entries.slice(0, 100)) {
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
