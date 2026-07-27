import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const UNKNOWN_APP = "unknown";
export const COMPANION_APP = "companion";
export const FOCUS_JSON_MARK = "COMPANION_FOCUS_JSON:";
export const KWIN_SCRIPT_NAME = "companion-focus";
export const ORB_TITLE = "Companion Orb";

export const EMPTY_FOCUS = Object.freeze({
  app: UNKNOWN_APP,
  title: UNKNOWN_APP,
  skip: false,
  pid: null,
});

/** Wire sizes for OS capture scripts / execFile — not behavior policy. */
export const IO = Object.freeze({
  clipboardRaw: 16000,
  a11yValue: 8000,
  a11ySelection: 8000,
  a11yName: 200,
  a11yRole: 120,
  windowApp: 80,
  windowTitle: 160,
  windowsMax: 12,
  openFiles: 16,
  recentFiles: 12,
  path: 260,
  url: 500,
  project: 80,
  fileHint: 120,
  shTimeoutMs: 8000,
  shMaxBuffer: 1048576,
  shQuickMs: 1500,
  shMediumMs: 3000,
  shFocusMs: 5000,
  shSlowMs: 10000,
  kwinSettleMs: 120,
});

export const SH_MS = Object.freeze({
  default: IO.shTimeoutMs,
  quick: IO.shQuickMs,
  medium: IO.shMediumMs,
  focus: IO.shFocusMs,
  slow: IO.shSlowMs,
  kwinSettle: IO.kwinSettleMs,
});

/** @deprecated use IO — kept as alias while adapters migrate */
export const LIMITS = IO;

export function orbTitle() {
  return ORB_TITLE;
}

export function sensePlatform() {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

export async function sh(cmd, args, opts = {}) {
  const timeout = opts.timeout ?? IO.shTimeoutMs;
  const maxBuffer = opts.maxBuffer ?? IO.shMaxBuffer;
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
  if (t.includes(ORB_TITLE)) return true;
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
      title: t || ORB_TITLE,
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
    app: String(w?.app || "").slice(0, IO.windowApp),
    title: String(w?.title || "").slice(0, IO.windowTitle),
    pid: w?.pid == null || w?.pid === "" ? null : Number(w.pid) || null,
  };
}

export function packWindows(list, max = IO.windowsMax) {
  return (list || [])
    .map(trimWindow)
    .filter((w) => w.app || w.title)
    .slice(0, max);
}

export async function listRecentFiles(dirs, limit = IO.recentFiles) {
  const found = [];
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const p = join(dir, ent.name);
        try {
          const st = await stat(p);
          found.push({ path: p, mtime: st.mtimeMs });
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
