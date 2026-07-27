import { readdir, readlink, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import {
  sh,
  packFocus,
  packWindows,
  pickApp,
  UNKNOWN_APP,
  LIMITS,
  FOCUS_JSON_MARK,
  KWIN_SCRIPT_NAME,
  SH_MS,
} from "./util.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KWIN_SCRIPT = join(ROOT, "lib", "sense", "kwin-active.js");
const KWIN_RC = join(homedir(), ".config", "kwinrc");

const CLIPBOARD_CMDS = [
  ["wl-paste", ["--no-newline"]],
  ["xclip", ["-selection", "clipboard", "-o"]],
  ["xsel", ["--clipboard", "--output"]],
];

const PRIMARY_CMDS = [
  ["wl-paste", ["--primary", "--no-newline"]],
  ["xclip", ["-selection", "primary", "-o"]],
  ["xsel", ["--primary", "--output"]],
];

function qdbusBin() {
  if (existsSync("/usr/bin/qdbus-qt6")) return "qdbus-qt6";
  if (existsSync("/usr/bin/qdbus6")) return "qdbus6";
  return "qdbus";
}

async function pasteVia(cmds) {
  for (const [cmd, args] of cmds) {
    const r = await sh(cmd, args, { timeout: SH_MS.quick });
    if (r.ok && r.stdout) return r.stdout.slice(0, LIMITS.clipboardRaw);
  }
  return "";
}

async function procNameFromPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    const comm = (await readFile(`/proc/${n}/comm`, "utf8")).trim();
    if (comm) return comm;
  } catch {
    /* ignore */
  }
  try {
    const raw = await readFile(`/proc/${n}/cmdline`, "utf8");
    const parts = raw.split("\0").filter(Boolean);
    if (parts[0]) return parts[0].split("/").pop() || "";
  } catch {
    /* ignore */
  }
  return "";
}

function readKwinFocusConfig() {
  if (!existsSync(KWIN_RC)) return null;
  const text = readFileSync(KWIN_RC, "utf8");
  const groups = text.split(/\n(?=\[)/);
  let best = null;
  for (const block of groups) {
    const head = block.split("\n", 1)[0] || "";
    if (!/companion-focus/i.test(head) && !/Script-companion/i.test(block)) {
      if (!/^\[Script[^\]]*\]/i.test(head.trim()) || !/updatedAt=/i.test(block)) {
        continue;
      }
    }
    const out = {};
    for (const line of block.split("\n")) {
      const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    if (out.caption != null || out.resourceClass != null || out.windows != null) {
      best = out;
      break;
    }
  }
  if (best) return best;
  const idx = text.search(/companion-focus/i);
  if (idx < 0) return null;
  const slice = text.slice(Math.max(0, idx - 20), idx + 4000);
  const out = {};
  for (const line of slice.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out.caption != null || out.resourceClass != null ? out : null;
}

function parseWindowsField(raw) {
  return packWindows(
    String(raw || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [title = "", app = "", pid = ""] = line.split("\t");
        return { title, app, pid };
      }),
  );
}

let lastWindows = [];
/** Once KWin dbus scripting proves broken on this session, stop hammering it. */
let kwinScriptDisabled = false;
let lastKwinFocus = null;
let a11yReady = false;

function parseFocusPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  lastWindows = Array.isArray(payload.windows)
    ? packWindows(payload.windows)
    : parseWindowsField(payload.windows);
  return {
    caption: String(payload.caption || ""),
    resourceClass: String(payload.resourceClass || ""),
    resourceName: String(payload.resourceName || ""),
    pid: Number(payload.pid || 0) || null,
    desktopFile: String(payload.desktopFile || ""),
  };
}

async function readKwinFocusFromJournal() {
  const r = await sh(
    "journalctl",
    ["--user", "-n", "30", "--no-pager", "-o", "cat", "--since", "3 seconds ago"],
    { timeout: SH_MS.medium },
  );
  if (!r.ok || !r.stdout) return null;
  const lines = r.stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const idx = line.indexOf(FOCUS_JSON_MARK);
    if (idx < 0) continue;
    try {
      return parseFocusPayload(
        JSON.parse(line.slice(idx + FOCUS_JSON_MARK.length)),
      );
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

async function focusViaKWinScript() {
  if (kwinScriptDisabled) return lastKwinFocus;
  if (!existsSync(KWIN_SCRIPT)) {
    kwinScriptDisabled = true;
    return null;
  }
  const qd = qdbusBin();
  await sh(
    qd,
    [
      "org.kde.KWin",
      "/Scripting",
      "org.kde.kwin.Scripting.unloadScript",
      KWIN_SCRIPT_NAME,
    ],
    { timeout: SH_MS.quick },
  );
  // Plasma 6: start() before loadScript so the script engine is alive.
  await sh(qd, ["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.start"], {
    timeout: SH_MS.quick,
  });
  const load = await sh(
    qd,
    [
      "org.kde.KWin",
      "/Scripting",
      "org.kde.kwin.Scripting.loadScript",
      KWIN_SCRIPT,
      KWIN_SCRIPT_NAME,
    ],
    { timeout: SH_MS.medium },
  );
  if (!load.ok) {
    kwinScriptDisabled = true;
    return null;
  }
  const id = String(load.stdout.trim() || "0");
  const tried = new Set();
  for (const sid of [id, "0", "1", "2"]) {
    if (tried.has(sid)) continue;
    tried.add(sid);
    const run = await sh(
      qd,
      ["org.kde.KWin", `/Scripting/Script${sid}`, "org.kde.kwin.Script.run"],
      { timeout: SH_MS.quick },
    );
    if (run.ok) break;
  }
  await new Promise((r) => setTimeout(r, SH_MS.kwinSettle));

  const info = readKwinFocusConfig();
  let parsed = info
    ? parseFocusPayload({
        caption: info.caption,
        resourceClass: info.resourceClass,
        resourceName: info.resourceName,
        pid: info.pid,
        desktopFile: info.desktopFile,
        windows: info.windows,
      })
    : null;
  if (!parsed?.caption && !parsed?.resourceClass) {
    parsed = await readKwinFocusFromJournal();
  }
  if (!parsed?.caption && !parsed?.resourceClass && !parsed?.pid) {
    kwinScriptDisabled = true;
    return lastKwinFocus;
  }

  const processName = await procNameFromPid(parsed.pid);
  const app = pickApp(
    processName,
    parsed.resourceClass,
    parsed.desktopFile,
    parsed.resourceName,
  );
  const packed = packFocus({
    app,
    title: parsed.caption || "",
    pid: parsed.pid || null,
    desktopFile: parsed.desktopFile || "",
  });
  lastKwinFocus = packed;
  return packed;
}

async function pidFromAppName(appName) {
  const want = String(appName || "")
    .trim()
    .toLowerCase()
    .replace(/\.desktop$/i, "");
  if (!want || want === UNKNOWN_APP) return null;
  try {
    const procs = await readdir("/proc");
    const hits = [];
    for (const ent of procs) {
      if (!/^\d+$/.test(ent)) continue;
      try {
        const comm = (await readFile(`/proc/${ent}/comm`, "utf8"))
          .trim()
          .toLowerCase();
        if (comm === want || want.includes(comm) || comm.includes(want)) {
          hits.push(Number(ent));
        }
      } catch {
        /* ignore */
      }
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return Math.max(...hits);
  } catch {
    /* ignore */
  }
  return null;
}

async function ensureA11yEnabled() {
  // Plasma/Wayland often leaves a11y off until a screen reader asks.
  const script = `
import sys
try:
  import dbus
  bus = dbus.SessionBus()
  obj = bus.get_object('org.a11y.Bus', '/org/a11y/bus')
  props = dbus.Interface(obj, 'org.freedesktop.DBus.Properties')
  for key in ('IsEnabled', 'ScreenReaderEnabled'):
    try:
      if not bool(props.Get('org.a11y.Status', key)):
        props.Set('org.a11y.Status', key, dbus.Boolean(True, variant_level=1))
    except Exception:
      pass
  print('ok')
except Exception as e:
  print('skip', e)
`;
  await sh("python3", ["-c", script], { timeout: SH_MS.medium });
}

async function listWindowsViaA11y() {
  if (!a11yReady) {
    await ensureA11yEnabled();
    a11yReady = true;
  }
  const maxWin = LIMITS.windowsMax;
  const script = `
import json
try:
  import gi
  gi.require_version('Atspi', '2.0')
  from gi.repository import Atspi
  Atspi.init()
  desk = Atspi.get_desktop(0)
  out = []
  for i in range(desk.get_child_count()):
    app = desk.get_child_at_index(i)
    try:
      an = app.get_name() or ''
    except Exception:
      an = ''
    try:
      n = app.get_child_count()
    except Exception:
      n = 0
    for j in range(min(n, 40)):
      try:
        ch = app.get_child_at_index(j)
      except Exception:
        continue
      try:
        rn = (ch.get_role_name() or '').lower()
        nm = (ch.get_name() or '').strip()
        st = ch.get_state_set()
        showing = bool(st and st.contains(Atspi.StateType.SHOWING))
      except Exception:
        continue
      if rn not in ('frame', 'window'): continue
      if not nm: continue
      if not showing: continue
      out.append({'app': an[:${LIMITS.windowApp}], 'title': nm[:${LIMITS.windowTitle}], 'pid': None})
      if len(out) >= ${maxWin}: break
    if len(out) >= ${maxWin}: break
  print(json.dumps(out))
except Exception:
  print('[]')
`;
  const r = await sh("python3", ["-c", script], { timeout: SH_MS.medium });
  if (!r.ok || !r.stdout) return [];
  try {
    const rows = JSON.parse(r.stdout);
    return Array.isArray(rows) ? packWindows(rows) : [];
  } catch {
    return [];
  }
}

export async function getFocus() {
  try {
    const a11y = await getA11yFocus();
    if (a11y && (a11y.app || a11y.title)) {
      let pid = null;
      const viaKwin = kwinScriptDisabled
        ? lastKwinFocus
        : await focusViaKWinScript();
      if (viaKwin?.pid) pid = viaKwin.pid;
      if (!pid) pid = await pidFromAppName(a11y.app);
      const packed = packFocus({
        app: a11y.app || a11y.title,
        title: a11y.title || a11y.name || "",
        pid,
      });
      if (packed && packed.app !== UNKNOWN_APP) return packed;
    }
  } catch {
    /* fall through */
  }

  const viaScript = kwinScriptDisabled
    ? lastKwinFocus
    : await focusViaKWinScript();
  if (viaScript) return viaScript;
  return null;
}

export async function listWindows() {
  if (!kwinScriptDisabled) {
    await focusViaKWinScript();
    if (lastWindows.length) return lastWindows;
  }
  const viaA11y = await listWindowsViaA11y();
  if (viaA11y.length) {
    lastWindows = viaA11y;
    return lastWindows;
  }
  return lastWindows;
}

export async function getClipboardText() {
  return pasteVia(CLIPBOARD_CMDS);
}

export async function getSelectionText() {
  return pasteVia(PRIMARY_CMDS);
}

export async function getA11yFocus() {
  if (!a11yReady) {
    await ensureA11yEnabled();
    a11yReady = true;
  }
  const textLimit = LIMITS.a11yValue;
  const script = `
import sys, json
try:
  import gi
  gi.require_version('Atspi', '2.0')
  from gi.repository import Atspi
  Atspi.init()
  desk = Atspi.get_desktop(0)

  def find_focused(acc, depth=0):
    if acc is None or depth > 36: return None
    try:
      st = acc.get_state_set()
      if st and st.contains(Atspi.StateType.FOCUSED):
        return acc
    except Exception:
      pass
    try:
      n = acc.get_child_count()
    except Exception:
      return None
    for j in range(min(n, 100)):
      try:
        ch = acc.get_child_at_index(j)
      except Exception:
        continue
      hit = find_focused(ch, depth+1)
      if hit: return hit
    return None

  def read_text(acc, limit=${textLimit}):
    if acc is None: return ''
    try:
      n = int(Atspi.Text.get_character_count(acc) or 0)
    except Exception:
      try:
        n = int(acc.get_character_count() or 0)
      except Exception:
        return ''
    if n <= 0: return ''
    end = min(n, int(limit))
    try:
      return Atspi.Text.get_text(acc, 0, end) or ''
    except Exception:
      return ''

  def read_selection(acc, limit=${textLimit}):
    if acc is None: return ''
    try:
      nsel = int(Atspi.Text.get_n_selections(acc) or 0)
    except Exception:
      nsel = 0
    if nsel > 0:
      try:
        s, e = Atspi.Text.get_selection(acc, 0)
        if e > s:
          return Atspi.Text.get_text(acc, int(s), min(int(e), int(s)+limit)) or ''
      except Exception:
        pass
    try:
      sels = acc.get_text_selections()
      if sels:
        first = sels[0]
        if hasattr(first, 'start_offset'):
          s, e = int(first.start_offset), int(first.end_offset)
          if e > s:
            return Atspi.Text.get_text(acc, s, min(e, s+limit)) or ''
    except Exception:
      pass
    return ''

  def find_text_node(root, depth=0):
    if root is None or depth > 12: return None
    try:
      rn = (root.get_role_name() or '').lower()
    except Exception:
      rn = ''
    prefer = rn in ('terminal', 'text', 'entry', 'password text', 'document web', 'edit bar', 'paragraph')
    try:
      if prefer or (hasattr(root, 'is_text') and root.is_text()):
        if read_text(root, 40) or read_selection(root, 40):
          return root
    except Exception:
      pass
    try:
      n = root.get_child_count()
    except Exception:
      return None
    for j in range(min(n, 80)):
      try:
        ch = root.get_child_at_index(j)
      except Exception:
        continue
      hit = find_text_node(ch, depth+1)
      if hit: return hit
    return None

  focused = None
  app_name = ''
  for i in range(desk.get_child_count()):
    app = desk.get_child_at_index(i)
    try:
      an = app.get_name() or ''
    except Exception:
      an = ''
    hit = find_focused(app)
    if hit:
      focused = hit
      app_name = an
      break
  if not focused:
    print('')
    sys.exit(0)

  text_acc = focused
  if not read_text(text_acc, 20) and not read_selection(text_acc, 20):
    frame = focused
    cur = focused
    for _ in range(24):
      try:
        rn = (cur.get_role_name() or '').lower()
        if rn in ('frame', 'window'):
          frame = cur
          break
        cur = cur.get_parent()
        if not cur: break
      except Exception:
        break
    text_acc = find_text_node(frame) or find_text_node(focused) or focused

  name = role = value = selection = ''
  password = False
  try:
    name = focused.get_name() or ''
  except Exception:
    pass
  try:
    role = (text_acc.get_role_name() or focused.get_role_name() or '')
  except Exception:
    pass
  try:
    st = text_acc.get_state_set()
    if st and st.contains(Atspi.StateType.PASSWORD_TEXT):
      password = True
  except Exception:
    pass
  if not password:
    value = read_text(text_acc, ${textLimit})
    selection = read_selection(text_acc, ${textLimit})
  title = ''
  frame_title = ''
  cur = focused
  for _ in range(24):
    try:
      rn = (cur.get_role_name() or '').lower()
      nm = (cur.get_name() or '').strip()
      if rn in ('frame', 'window') and nm and not frame_title:
        frame_title = nm
      elif rn == 'application' and nm and not title:
        title = nm
      cur = cur.get_parent()
      if not cur: break
    except Exception:
      break
  print(json.dumps({
    'name': name,
    'role': role,
    'value': value,
    'selection': selection,
    'password_field': password,
    'app': app_name,
    'title': frame_title or title or name,
  }))
except Exception:
  print('')
`;
  const r = await sh("python3", ["-c", script], { timeout: SH_MS.focus });
  if (!r.ok || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

export async function listOpenFiles(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return [];
  const home = homedir();
  const out = [];
  try {
    const fds = await readdir(`/proc/${n}/fd`);
    for (const fd of fds.slice(0, 96)) {
      try {
        const target = await readlink(`/proc/${n}/fd/${fd}`);
        if (!target.startsWith("/") && !/^[A-Za-z]:\\/.test(target)) continue;
        if (target.includes("(deleted)")) continue;
        if (/^\/(proc|dev|sys|run|tmp)\//.test(target)) continue;
        if (
          !target.startsWith(home) &&
          !/^\/(home|mnt|media|run\/media)\//.test(target)
        ) {
          continue;
        }
        out.push(target.slice(0, LIMITS.path));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return [...new Set(out)].slice(0, LIMITS.openFiles);
}

/**
 * Input idle via systemd-logind (mouse/keyboard quiet).
 * IdleSinceHint is CLOCK_MONOTONIC µs; /proc/uptime is a close match.
 */
export async function getIdleMs() {
  const sid = String(process.env.XDG_SESSION_ID || "").trim() || "self";
  const r = await sh(
    "loginctl",
    ["show-session", sid, "-p", "IdleHint", "-p", "IdleSinceHint"],
    { timeout: SH_MS.quick },
  );
  if (!r.ok) return null;
  const hint = /IdleHint=(yes|no)/i.exec(r.stdout)?.[1]?.toLowerCase();
  const since = /IdleSinceHint=(\d+)/.exec(r.stdout)?.[1];
  if (hint === "no" || !since || since === "0") return 0;
  try {
    const uptimeSec = Number(
      (await readFile("/proc/uptime", "utf8")).split(/\s+/)[0],
    );
    if (!Number.isFinite(uptimeSec)) return null;
    const idleMs = Math.max(0, uptimeSec * 1000 - Number(since) / 1000);
    return Math.round(idleMs);
  } catch {
    return null;
  }
}
