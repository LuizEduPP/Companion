/**
 * Sense orchestrator — OS adapters behind one activity payload.
 * Never call org.kde.KWin.queryWindowInfo (interactive mouse grab).
 */
import { config } from "./config.mjs";
import { inferFromTitle } from "./sense/infer.mjs";
import {
  captureEnabled,
  redactSecrets,
  isInfraNoise,
  EMPTY_FOCUS,
} from "./sense/util.mjs";

async function loadAdapter() {
  if (process.platform === "win32") return import("./sense/win32.mjs");
  if (process.platform === "darwin") return import("./sense/darwin.mjs");
  return import("./sense/linux.mjs");
}

const typedState = {
  buf: "",
  lastApp: "",
  lastFlushAt: 0,
  idleTimer: null,
  lastA11yValue: "",
  password: false,
};

const quietTracker = {
  fingerprint: "",
  lastChangeAt: Date.now(),
};

function activityFingerprint(activity) {
  return [
    activity.focus?.app || "",
    activity.focus?.title || "",
    activity.a11y?.value?.slice(-80) || "",
    activity.a11y?.selection?.slice(0, 80) || "",
    activity.selection?.text?.slice(0, 80) || "",
    activity.clipboard?.text?.slice(0, 80) || "",
    (activity.open_files || []).slice(0, 4).join("|"),
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

function watchDirs() {
  const raw = process.env.COMPANION_WATCH_DIRS || "";
  return raw
    .split(/[,:;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function scheduleTypedFlush(onFlush) {
  if (typedState.idleTimer) clearTimeout(typedState.idleTimer);
  typedState.idleTimer = setTimeout(() => {
    typedState.idleTimer = null;
    const text = typedState.buf.trim();
    if (!text || typedState.password) {
      typedState.buf = "";
      return;
    }
    if (text.length < 2) return;
    const payload = {
      text: redactSecrets(text).slice(0, config.typeMaxChars),
      idle_ms: config.typeIdleMs,
      app: typedState.lastApp,
      password_field: false,
    };
    typedState.buf = "";
    typedState.lastFlushAt = Date.now();
    onFlush(payload);
  }, config.typeIdleMs);
}

/** Feed printable key / a11y delta into the idle buffer. */
export function feedTyped(chunk, { app = "", password = false } = {}, onFlush) {
  if (!captureEnabled("COMPANION_CAPTURE_TYPED", config.captureAll)) return;
  if (password) {
    typedState.password = true;
    typedState.buf = "";
    return;
  }
  typedState.password = false;
  if (app) typedState.lastApp = app;
  const s = String(chunk ?? "");
  if (!s) return;
  typedState.buf = (typedState.buf + s).slice(-config.typeMaxChars);
  scheduleTypedFlush(onFlush);
}

function syncTypedFromA11y(a11y, focus, onFlush) {
  if (!a11y) return;
  if (a11y.password_field) {
    typedState.password = true;
    typedState.buf = "";
    typedState.lastA11yValue = "";
    return;
  }
  const value = String(a11y.value || "");
  if (!value || isInfraNoise(value)) return;
  if (value === typedState.lastA11yValue) return;
  const prev = typedState.lastA11yValue;
  typedState.lastA11yValue = value;
  // Prefer full field value as the composition buffer (idle flush sends all).
  if (value.length >= prev.length && value.startsWith(prev)) {
    typedState.buf = value;
  } else {
    typedState.buf = value;
  }
  typedState.lastApp = focus?.app || typedState.lastApp;
  typedState.password = false;
  scheduleTypedFlush(onFlush);
}

/** Active window focus. */
export async function getActiveFocus() {
  const adapter = await loadAdapter();
  const focus = await adapter.getFocus();
  return focus || { ...EMPTY_FOCUS };
}

/**
 * Full activity snapshot for POST /api/pc/activity.
 * @param {{ onTypedFlush?: (typed: object) => void }} [hooks]
 */
export async function collectActivity(hooks = {}) {
  const adapter = await loadAdapter();
  const onTypedFlush = hooks.onTypedFlush || (() => {});
  const platform = process.platform === "win32"
    ? "win32"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";

  const focus =
    (await adapter.getFocus()) || { ...EMPTY_FOCUS };

  const inferred = inferFromTitle(focus.app, focus.title);
  const activity = {
    at: new Date().toISOString(),
    platform,
    focus: {
      app: focus.app,
      title: focus.title,
      pid: focus.pid ?? null,
      kind: inferred.kind,
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

  if (inferred.url && captureEnabled("COMPANION_CAPTURE_BROWSER", config.captureAll)) {
    activity.page = { url: inferred.url, title: focus.title };
  }

  if (inferred.file && captureEnabled("COMPANION_CAPTURE_FILES", config.captureAll)) {
    activity.file = {
      path: inferred.file,
      name: inferred.file_name || inferred.file.split(/[/\\]/).pop(),
    };
  }

  if (captureEnabled("COMPANION_CAPTURE_A11Y", config.captureAll)) {
    try {
      const a11y = await adapter.getA11yFocus();
      if (a11y) {
        const sel = a11y.password_field
          ? ""
          : redactSecrets(String(a11y.selection || "")).slice(0, 8000);
        activity.a11y = {
          name: String(a11y.name || "").slice(0, 200),
          role: String(a11y.role || "").slice(0, 120),
          value: a11y.password_field
            ? ""
            : redactSecrets(String(a11y.value || "")).slice(0, 8000),
          selection: sel,
          password_field: Boolean(a11y.password_field),
        };
        if (sel) {
          activity.selection = { text: sel, source: "a11y" };
        }
        syncTypedFromA11y(a11y, focus, onTypedFlush);
        // Live field text for the brain even before idle flush.
        if (
          captureEnabled("COMPANION_CAPTURE_TYPED", config.captureAll) &&
          activity.a11y.value &&
          !activity.a11y.password_field &&
          !isInfraNoise(activity.a11y.value)
        ) {
          const raw = activity.a11y.value;
          // Terminals/documents: keep the tail (where typing happens).
          const text =
            raw.length > config.typeMaxChars
              ? raw.slice(-config.typeMaxChars)
              : raw;
          activity.typed = {
            text,
            idle_ms: 0,
            app: focus.app || "",
            password_field: false,
            live: true,
          };
        }
      }
    } catch {
      /* optional */
    }
  }

  if (captureEnabled("COMPANION_CAPTURE_CLIPBOARD", config.captureAll)) {
    try {
      const clip = await adapter.getClipboardText();
      if (clip) {
        activity.clipboard = { text: redactSecrets(clip).slice(0, 8000) };
      }
    } catch {
      /* optional */
    }
    try {
      if (typeof adapter.getSelectionText === "function") {
        const sel = await adapter.getSelectionText();
        const clean = sel ? redactSecrets(sel).slice(0, 8000) : "";
        const prev = activity.selection?.text || "";
        // Prefer a11y selection; ignore tiny primary crumbs (e.g. single char).
        if (
          clean &&
          clean !== activity.clipboard?.text &&
          clean.length >= 8 &&
          clean.length >= prev.length
        ) {
          activity.selection = {
            text: clean,
            source: "primary",
          };
        }
      }
    } catch {
      /* optional */
    }
  }

  if (typeof adapter.listWindows === "function") {
    try {
      activity.windows = await adapter.listWindows();
    } catch {
      activity.windows = [];
    }
  }

  if (captureEnabled("COMPANION_CAPTURE_FILES", config.captureAll)) {
    try {
      activity.open_files = await adapter.listOpenFiles(focus.pid);
      if (!activity.file && activity.open_files[0]) {
        activity.file = {
          path: activity.open_files[0],
          name: activity.open_files[0].split(/[/\\]/).pop(),
        };
      }
      activity.recent_files = await adapter.listRecentFiles(watchDirs(), 12);
    } catch {
      /* optional */
    }
  }

  const quietMs = updateQuietMs(activity);
  let inputMs = null;
  try {
    if (typeof adapter.getIdleMs === "function") {
      inputMs = await adapter.getIdleMs();
    }
  } catch {
    inputMs = null;
  }
  const threshold = config.pcIdleMs;
  const effectiveMs =
    inputMs != null && Number.isFinite(inputMs)
      ? Math.max(inputMs, quietMs)
      : quietMs;
  activity.idle = {
    input_ms: inputMs,
    quiet_ms: quietMs,
    threshold_ms: threshold,
    idle: effectiveMs >= threshold,
  };

  return activity;
}

export { inferFromTitle };
