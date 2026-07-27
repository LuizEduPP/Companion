import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ORB_TITLE =
  String(process.env.COMPANION_ORB_TITLE || "Companion Orb").trim() ||
  "Companion Orb";

export const UNKNOWN_APP = "unknown";
export const COMPANION_APP = "companion";

export const EMPTY_FOCUS = Object.freeze({
  app: UNKNOWN_APP,
  title: UNKNOWN_APP,
  skip: false,
  pid: null,
});

export async function sh(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: opts.timeout ?? 8000,
      maxBuffer: opts.maxBuffer ?? 1024 * 1024,
      env: opts.env ?? process.env,
      ...opts,
    });
    return { ok: true, stdout: String(stdout || "").trim(), stderr: String(stderr || "") };
  } catch (err) {
    return { ok: false, stdout: "", stderr: err.message, err };
  }
}

export function isOrb(app, title) {
  const t = String(title || "");
  const a = String(app || "").toLowerCase();
  if (t.includes(ORB_TITLE)) return true;
  // Title alone is enough; avoid matching unrelated Electron apps.
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
 * Returns true when the blob is infra noise rather than human content.
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
  // Own source / data paths — IDE selection while editing companion.
  if (
    /\/companion\//i.test(t) ||
    /\/companion\/(lib|public|data|prompts|orb)\//i.test(t)
  ) {
    return true;
  }
  if (/"episodes"\s*:/.test(t) && /"knows"\s*:/.test(t)) {
    return true;
  }
  if (/"type"\s*:\s*"pc_(focus|typed|a11y|clipboard|windows)"/.test(t)) return true;
  // Terminal scrollback that is mostly companion log lines.
  const lines = t.split(/\n/).filter((l) => l.trim());
  if (lines.length >= 3) {
    const noisy = lines.filter((l) =>
      /\[(?:hot|brain|sense)\]|think JSON|companion /i.test(l),
    ).length;
    if (noisy / lines.length >= 0.4) return true;
  }
  return false;
}

export function captureEnabled(flagName, masterOn) {
  if (!masterOn) return false;
  const v = process.env[flagName];
  if (v === undefined || v === "") return true;
  return !["0", "false", "no", "off"].includes(String(v).toLowerCase());
}

/** Shared recent-files scan for watch dirs (no fixed home folder catalog). */
export async function listRecentFiles(dirs, limit = 12) {
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
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, limit).map((f) => f.path);
}
