/**
 * Sense orchestrator — OS adapters behind one activity payload.
 * No capture flags / noise classifiers — raw observation only.
 * Never call org.kde.KWin.queryWindowInfo (interactive mouse grab).
 */
import { inferFromTitle } from "./sense/infer.mjs";
import {
  EMPTY_FOCUS,
  IO,
  sensePlatform,
  listRecentFiles,
} from "./sense/util.mjs";

async function loadAdapter() {
  const platform = sensePlatform();
  if (platform === "win32") return import("./sense/win32.mjs");
  if (platform === "darwin") return import("./sense/darwin.mjs");
  return import("./sense/linux.mjs");
}

const quietTracker = {
  fingerprint: "",
  lastChangeAt: Date.now(),
};

function activityFingerprint(activity) {
  return [
    activity.focus?.app || "",
    activity.focus?.title || "",
    activity.a11y?.value || "",
    activity.a11y?.selection || "",
    activity.selection?.text || "",
    activity.clipboard?.text || "",
    (activity.open_files || []).join("|"),
  ].join("\0");
}

function updateQuietMs(activity) {
  const fp = activityFingerprint(activity);
  if (fp !== quietTracker.fingerprint) {
    quietTracker.fingerprint = fp;
    quietTracker.lastChangeAt = Date.now();
  }
  return Math.max(0, Date.now() - quietTracker.lastChangeAt);
}

/** Active window focus. */
export async function getActiveFocus() {
  const adapter = await loadAdapter();
  const focus = await adapter.getFocus();
  return focus || { ...EMPTY_FOCUS };
}

/**
 * Full activity snapshot for POST /api/pc/activity.
 */
export async function collectActivity() {
  const adapter = await loadAdapter();
  const platform = sensePlatform();

  const focus = (await adapter.getFocus()) || { ...EMPTY_FOCUS };
  const inferred = inferFromTitle(focus.app, focus.title);
  const activity = {
    at: new Date().toISOString(),
    platform,
    focus: {
      app: focus.app,
      title: focus.title,
      pid: focus.pid ?? null,
      skip: Boolean(focus.skip),
      desktopFile: focus.desktopFile || "",
    },
    page: null,
    file: null,
    typed: null,
    clipboard: null,
    selection: null,
    a11y: null,
    windows: [],
    recent_files: [],
    open_files: [],
    inference: inferred,
  };

  if (focus.skip) return activity;

  if (inferred.url) {
    activity.page = { url: inferred.url, title: focus.title };
  }

  if (inferred.file) {
    activity.file = {
      path: inferred.file,
      name: inferred.file_name || inferred.file.split(/[/\\]/).pop(),
    };
  }

  try {
    const a11y = await adapter.getA11yFocus();
    if (a11y) {
      const sel = a11y.password_field
        ? ""
        : String(a11y.selection || "").slice(0, IO.a11ySelection);
      const value = a11y.password_field
        ? ""
        : String(a11y.value || "").slice(0, IO.a11yValue);
      activity.a11y = {
        name: String(a11y.name || "").slice(0, IO.a11yName),
        role: String(a11y.role || "").slice(0, IO.a11yRole),
        value,
        selection: sel,
        password_field: Boolean(a11y.password_field),
      };
      if (sel) activity.selection = { text: sel, source: "a11y" };
      if (value && !a11y.password_field) {
        activity.typed = {
          text: value,
          idle_ms: 0,
          app: focus.app || "",
          password_field: false,
          live: true,
        };
      }
    }
  } catch (err) {
    console.warn("[sense:a11y]", err.message);
  }

  try {
    const clip = await adapter.getClipboardText();
    if (clip) {
      activity.clipboard = {
        text: String(clip).slice(0, IO.clipboardRaw),
      };
    }
  } catch (err) {
    console.warn("[sense:clipboard]", err.message);
  }

  try {
    if (typeof adapter.getSelectionText === "function") {
      const sel = await adapter.getSelectionText();
      const clean = sel ? String(sel).slice(0, IO.clipboardRaw) : "";
      if (clean && clean !== activity.clipboard?.text) {
        activity.selection = { text: clean, source: "primary" };
      }
    }
  } catch (err) {
    console.warn("[sense:selection]", err.message);
  }

  if (typeof adapter.listWindows === "function") {
    try {
      activity.windows = await adapter.listWindows();
    } catch (err) {
      console.warn("[sense:windows]", err.message);
      activity.windows = [];
    }
  }

  try {
    activity.open_files = await adapter.listOpenFiles(focus.pid);
    if (!activity.file && activity.open_files[0]) {
      activity.file = {
        path: activity.open_files[0],
        name: activity.open_files[0].split(/[/\\]/).pop(),
      };
    }
    activity.recent_files = await listRecentFiles([], IO.recentFiles);
  } catch (err) {
    console.warn("[sense:files]", err.message);
  }

  const quietMs = updateQuietMs(activity);
  let inputMs = null;
  try {
    if (typeof adapter.getIdleMs === "function") {
      inputMs = await adapter.getIdleMs();
    }
  } catch (err) {
    console.warn("[sense:idle]", err.message);
    inputMs = null;
  }
  activity.idle = {
    input_ms: inputMs,
    quiet_ms: quietMs,
  };

  return activity;
}

export { inferFromTitle };
