/**
 * Thin tool executor — schema validate + run + observation.
 * No “should I?” heuristics; the model decides when to call.
 */
import { platform } from "node:os";
import {
  loadStore,
  upsertKnow,
  getUserProfile,
  patchUserProfile,
  getWorldSnapshot,
} from "./store.mjs";
import { sh, IO, SH_MS } from "./sense/util.mjs";

/** Clipboard write uses the same OS capture buffer size as sense (I/O wire). */
const CLIPBOARD_WRITE_MAX = IO.clipboardRaw;

export const TOOL_CATALOG = Object.freeze([
  {
    tool: "memory_read",
    args: {
      query: "string — substring match (optional)",
      kind: "knows|episodes|user|all (default all)",
      limit: "number optional — if set, model-chosen slice",
    },
  },
  {
    tool: "memory_search",
    args: {
      query: "string required — substring across knows+episodes+user",
      limit: "number optional — if set, model-chosen slice",
    },
  },
  {
    tool: "episodes_since",
    args: {
      since: "ISO timestamp (required) — episodes with at >= since",
      type: "string optional — episode.type filter",
      limit: "number optional — if set, model-chosen slice",
    },
  },
  {
    tool: "memory_write",
    args: {
      knows: "string or [string] — durable notes",
      notes: "string — append user.notes",
      name: "string — user display name",
    },
  },
  {
    tool: "notify",
    args: { title: "string optional", body: "string required" },
  },
  {
    tool: "open_or_focus",
    args: { target: "string — url, path, or app id" },
  },
  {
    tool: "clipboard_write",
    args: { text: "string" },
  },
]);

const ALLOWED = new Set(TOOL_CATALOG.map((t) => t.tool));

export function normalizeActions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const tool = String(item.tool || item.name || "").trim();
    if (!ALLOWED.has(tool)) continue;
    const args =
      item.args && typeof item.args === "object" && !Array.isArray(item.args)
        ? item.args
        : {};
    out.push({ tool, args });
  }
  return out;
}

function ok(tool, args, result) {
  return { tool, args, ok: true, result };
}

function fail(tool, args, error) {
  return { tool, args, ok: false, error: String(error || "failed") };
}

function episodeBlob(e) {
  return JSON.stringify(e ?? {});
}

/** Optional model-chosen slice; omit/invalid → no host cap. */
function optionalSlice(list, rawLimit) {
  if (rawLimit == null || rawLimit === "") return list;
  const n = Number(rawLimit);
  if (!Number.isFinite(n) || n < 1) return list;
  return list.slice(0, Math.floor(n));
}

function memoryRead(args) {
  const kind = String(args.kind || "all").toLowerCase();
  const query = String(args.query || "")
    .trim()
    .toLowerCase();
  const store = loadStore();
  const world = getWorldSnapshot();
  const hit = (text) =>
    !query || String(text || "").toLowerCase().includes(query);

  const out = {};
  if (kind === "user" || kind === "all") {
    const user = getUserProfile();
    out.user = {
      name: user.name || "",
      locale: user.locale || "",
      notes: String(user.notes || ""),
      gaps: world.gaps ?? [],
    };
  }
  if (kind === "knows" || kind === "all") {
    const knows = (store.knows || [])
      .map((k) => (typeof k === "string" ? k : String(k?.text || "")))
      .filter((t) => t && hit(t));
    out.knows = optionalSlice(knows, args.limit);
  }
  if (kind === "episodes" || kind === "all") {
    const eps = [...(store.episodes || [])]
      .reverse()
      .filter((e) => hit(episodeBlob(e)));
    out.episodes = optionalSlice(eps, args.limit);
  }
  return out;
}

/** Substring search — no relevance ranking, literal match only. */
function memorySearch(args) {
  const query = String(args.query || "").trim();
  if (!query) return null;
  return memoryRead({ query, kind: "all", limit: args.limit });
}

function episodesSince(args) {
  const sinceRaw = String(args.since || args.from || "").trim();
  if (!sinceRaw) return null;
  const sinceMs = Date.parse(sinceRaw);
  if (!Number.isFinite(sinceMs)) return null;
  const type = String(args.type || "").trim();
  const store = loadStore();
  const eps = (store.episodes || []).filter((e) => {
    const at = Date.parse(e?.at || "");
    if (!Number.isFinite(at) || at < sinceMs) return false;
    if (type && e?.type !== type) return false;
    return true;
  });
  const sliced = optionalSlice(eps, args.limit);
  return {
    since: new Date(sinceMs).toISOString(),
    type: type || null,
    count: eps.length,
    episodes: sliced,
  };
}

function memoryWrite(args) {
  const summary = { knows: [], user: false };
  const knowsRaw = args.knows;
  const list = Array.isArray(knowsRaw)
    ? knowsRaw
    : typeof knowsRaw === "string"
      ? [knowsRaw]
      : [];
  for (const text of list) {
    const row = upsertKnow({ text: String(text || "") });
    if (row) summary.knows.push({ text: row.text, status: row._status });
  }
  const patch = {};
  if (typeof args.notes === "string" && args.notes.trim()) {
    patch.notes = args.notes.trim();
  }
  if (typeof args.name === "string" && args.name.trim()) {
    patch.name = args.name.trim();
  }
  if (Object.keys(patch).length) {
    const before = getUserProfile();
    patchUserProfile(patch);
    const after = getUserProfile();
    summary.user =
      before.name !== after.name || before.notes !== after.notes;
  }
  return summary;
}

async function notify(args) {
  const body = String(args.body || args.text || "").trim();
  if (!body) return fail("notify", args, "body required");
  const title = String(args.title || "Companion").trim() || "Companion";
  const p = platform();
  let r;
  if (p === "darwin") {
    const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
    r = await sh("osascript", ["-e", script], { timeout: SH_MS.medium });
  } else if (p === "win32") {
    const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode(${JSON.stringify(title)})) | Out-Null
$xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode(${JSON.stringify(body)})) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Companion').Show($toast)
`;
    r = await sh("powershell", ["-NoProfile", "-Command", ps], {
      timeout: SH_MS.medium,
    });
  } else {
    r = await sh("notify-send", [title, body], { timeout: SH_MS.quick });
  }
  if (!r.ok) return fail("notify", { title, body }, r.stderr || "notify failed");
  return ok("notify", { title, body }, { sent: true });
}

async function openOrFocus(args) {
  const target = String(args.target || args.url || args.path || "").trim();
  if (!target) return fail("open_or_focus", args, "target required");
  const p = platform();
  let r;
  if (p === "darwin") {
    r = await sh("open", [target], { timeout: SH_MS.medium });
  } else if (p === "win32") {
    r = await sh(
      "powershell",
      ["-NoProfile", "-Command", `Start-Process ${JSON.stringify(target)}`],
      { timeout: SH_MS.medium },
    );
  } else {
    r = await sh("xdg-open", [target], { timeout: SH_MS.medium });
  }
  if (!r.ok) {
    return fail("open_or_focus", { target }, r.stderr || "open failed");
  }
  return ok("open_or_focus", { target }, { opened: true });
}

async function writeStdin(cmd, cmdArgs, text) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, cmdArgs, { stdio: ["pipe", "ignore", "pipe"] });
      let failed = false;
      child.on("error", () => {
        failed = true;
        resolve(false);
      });
      child.stdin.on("error", () => {
        failed = true;
      });
      child.stdin.end(text);
      child.on("close", (code) => resolve(!failed && code === 0));
    } catch {
      resolve(false);
    }
  });
}

async function clipboardWrite(args) {
  const text = String(args.text ?? "").slice(0, CLIPBOARD_WRITE_MAX);
  if (!text) return fail("clipboard_write", args, "text required");
  const p = platform();
  if (p === "darwin") {
    const wrote = await writeStdin("pbcopy", [], text);
    if (!wrote) return fail("clipboard_write", {}, "pbcopy failed");
    return ok("clipboard_write", { bytes: text.length }, { written: true });
  }
  if (p === "win32") {
    const r = await sh(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Set-Clipboard -Value ${JSON.stringify(text)}`,
      ],
      { timeout: SH_MS.medium },
    );
    if (!r.ok) return fail("clipboard_write", {}, r.stderr || "clipboard failed");
    return ok("clipboard_write", { bytes: text.length }, { written: true });
  }
  for (const [cmd, cmdArgs] of [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ]) {
    if (await writeStdin(cmd, cmdArgs, text)) {
      return ok("clipboard_write", { bytes: text.length }, {
        written: true,
        via: cmd,
      });
    }
  }
  return fail("clipboard_write", {}, "no clipboard backend (wl-copy/xclip/xsel)");
}

async function runOne(action) {
  const { tool, args } = action;
  try {
    if (tool === "memory_read") return ok(tool, args, memoryRead(args));
    if (tool === "memory_search") {
      const hit = memorySearch(args);
      if (!hit) return fail(tool, args, "query required");
      return ok(tool, args, hit);
    }
    if (tool === "episodes_since") {
      const hit = episodesSince(args);
      if (!hit) return fail(tool, args, "since must be a valid ISO timestamp");
      return ok(tool, args, hit);
    }
    if (tool === "memory_write") return ok(tool, args, memoryWrite(args));
    if (tool === "notify") return notify(args);
    if (tool === "open_or_focus") return openOrFocus(args);
    if (tool === "clipboard_write") return clipboardWrite(args);
    return fail(tool, args, "unknown tool");
  } catch (err) {
    return fail(tool, args, err.message || String(err));
  }
}

/**
 * Execute normalized actions sequentially; return observations for next tick.
 */
export async function executeActions(actions) {
  const list = normalizeActions(actions);
  const results = [];
  for (const action of list) {
    // eslint-disable-next-line no-await-in-loop — sequential on purpose
    results.push(await runOne(action));
  }
  return results;
}

export { ALLOWED as TOOL_NAMES };
