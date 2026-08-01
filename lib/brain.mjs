import { readFileSync } from "node:fs";
import { config } from "./config.mjs";
import { ORB } from "./presentation.mjs";
import { inferFromTitle } from "./sense/infer.mjs";
import { packWindows, IO } from "./sense/util.mjs";
import {
  appendEpisode,
  loadStore,
  getHostContext,
  applyLearn,
  applyIntent,
  getIntent,
  setLastOutcome,
  getWorldSnapshot,
  getUserProfile,
} from "./store.mjs";
import {
  TOOL_CATALOG,
  normalizeActions,
  executeActions,
} from "./tools.mjs";
import { DEFAULT_FACE, FACE_KEYS, normalizeFace } from "./avatar.mjs";

/* ── orb UI state ─────────────────────────────────────────────────── */

const orbUi = {
  face: { ...DEFAULT_FACE },
  caption: "",
};

function setFace(face) {
  if (!face) return;
  orbUi.face = face;
}

function setCaption(text) {
  orbUi.caption = String(text ?? "").trim();
}

export function getOrbState() {
  return {
    face: { ...orbUi.face },
    caption: orbUi.caption,
  };
}

/* ── LLM ──────────────────────────────────────────────────────────── */

function authHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  return headers;
}

function stripMarkdownFences(text) {
  let s = String(text ?? "").trim();
  const fenced = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  s = s.replace(/^```(?:json|JSON)?\s*/i, "").replace(/```$/i, "").trim();
  return s;
}

/** Strict JSON object parse — no repair of incomplete/broken model output. */
function parseJsonObject(text) {
  const raw = stripMarkdownFences(text);
  if (!raw) return null;

  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return direct;
    }
  } catch {
    /* try braced extract */
  }

  const start = raw.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  // Incomplete object (model cut braces) — reject; prompt must emit valid JSON.
  if (end < start) return null;

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

async function chatCompletions({ model, messages }) {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`chat failed ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const choice = data?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const finish = choice.finish_reason || "?";
  const content = typeof msg.content === "string" ? msg.content.trim() : "";
  if (!content) {
    throw new Error(`empty model content (finish=${finish})`);
  }
  return { content, finish };
}

function coerceKnowsList(raw) {
  if (!raw) return [];
  if (typeof raw === "string") {
    const s = raw.trim();
    return s ? [s] : [];
  }
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === "string" ? item : item?.text))
      .map((s) => String(s || "").trim())
      .filter(Boolean);
  }
  if (typeof raw === "object") {
    return Object.values(raw)
      .map((item) => (typeof item === "string" ? item : item?.text))
      .map((s) => String(s || "").trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeDecision(parsed) {
  const raw = parsed && typeof parsed === "object" ? parsed : {};
  let learn =
    raw.learn && typeof raw.learn === "object" && !Array.isArray(raw.learn)
      ? { ...raw.learn }
      : {};
  // Tiny models sometimes put knows at the top level.
  if (learn.knows == null && raw.knows != null) learn.knows = raw.knows;
  if ("emotion" in learn || "focus" in learn || "face" in learn) {
    const { emotion: _e, focus: _f, face: _face, ...rest } = learn;
    learn = rest;
  }
  const cleanLearn = {};
  if (learn.user && typeof learn.user === "object") cleanLearn.user = learn.user;
  const knowsList = coerceKnowsList(learn.knows);
  if (knowsList.length) cleanLearn.knows = knowsList;

  const silence = raw.silence === true;
  const speakRaw =
    typeof raw.speak === "string" ? raw.speak.trim() || null : null;
  const speak = silence ? null : speakRaw;
  const intent =
    raw.intent && typeof raw.intent === "object" && !Array.isArray(raw.intent)
      ? raw.intent
      : raw.intent === null
        ? null
        : undefined;
  const face = normalizeFace(raw.face ?? raw.avatar ?? raw.pose, orbUi.face);
  return {
    silence,
    speak,
    face,
    learn: cleanLearn,
    intent: intent === undefined ? null : intent,
    actions: normalizeActions(raw.actions),
  };
}

function windowsForModel(list) {
  return packWindows(list).map((w) => ({ app: w.app, title: w.title }));
}

/** Raw human content — trim only, no noise / infra filters. */
function humanContent() {
  const clip = String(state.activity.clipboard?.text || "").trim() || null;
  const sel = String(state.activity.selection?.text || "").trim() || null;
  const typed = String(state.activity.typed?.text || "").trim() || null;
  const a11y = String(state.activity.a11y?.value || "").trim() || null;
  const page = state.activity.page?.url || null;
  const file = state.activity.file?.path || null;
  return { clip, sel, typed, a11y, page, file };
}

async function thinkAlive({
  world,
  lastSpeak,
  focus,
  inference,
  situation,
  signals,
  host,
  toolResults,
  intent,
  parseError,
}) {
  // System = constitution identity; user = sensors/memory JSON. No decision gates here.
  const system = readFileSync(config.promptPath, "utf8");
  const userProf = world.user
    ? {
        name: world.user.name || "",
        locale: world.user.locale || "",
        notes: String(world.user.notes || ""),
      }
    : {};
  const clock = host || getHostContext();
  const windows = windowsForModel(state.activity.windows);
  const hc = humanContent();
  const sigs = Array.isArray(signals) ? signals : situation?.signals || [];
  const knowsAll = world.knows ?? [];
  const store = loadStore();
  const payload = {
    now: {
      clock: clock.local_clock || "",
      date: clock.local_date || "",
      weekday: clock.weekday || "",
      timezone: clock.timezone || "",
      label: clock.now || "",
    },
    windows,
    user: userProf,
    gaps: world.gaps ?? [],
    knows: knowsAll,
    memory: {
      knows_count: knowsAll.length,
      episodes_count: (store.episodes || []).length,
    },
    focus,
    inference,
    intent: intent ?? world.intent ?? getIntent(),
    tools: TOOL_CATALOG,
    tool_results: Array.isArray(toolResults) ? toolResults : [],
    /** Prior turn discarded — raw observation; you must emit complete JSON. */
    last_parse_error: parseError || null,
    activity: {
      page: state.activity.page,
      file: state.activity.file,
      typed: hc.typed ? { text: hc.typed } : null,
      selection: hc.sel ? { text: hc.sel } : null,
      clipboard: hc.clip ? { text: hc.clip } : null,
      open_files: (state.activity.open_files || []).slice(0, IO.openFiles),
      windows,
      idle: state.activity.idle || null,
      a11y: state.activity.a11y
        ? {
            name: state.activity.a11y.name,
            role: state.activity.a11y.role,
            value: String(state.activity.a11y.value || "").slice(
              0,
              IO.a11yValue,
            ),
            selection: String(state.activity.a11y.selection || "").slice(
              0,
              IO.a11ySelection,
            ),
          }
        : null,
    },
    situation: {
      signals: sigs,
      reason: sigs.join("+"),
      nudge: sigs.includes("nudge"),
      autonomous: true,
      last_balloon: lastSpeak || null,
      app: situation?.app || "",
      title: situation?.title || "",
      events: sigs,
    },
    face: orbUi.face,
    face_keys: FACE_KEYS,
  };

  const { content, finish } = await chatCompletions({
    model: config.chatModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });

  const parsed = parseJsonObject(content);
  if (parsed) {
    state.lastParseError = null;
    return normalizeDecision(parsed);
  }

  state.lastParseError = {
    finish,
    incomplete: !String(content).trim().endsWith("}"),
    raw: String(content ?? ""),
  };
  console.warn(
    `[companion:think-llm] invalid JSON from model → keep prior orb (finish=${finish}):`,
    String(content).slice(0, 240),
  );
  return null;
}

/* ── brain ────────────────────────────────────────────────────────── */

const state = {
  focus: { app: "", title: "", workspace: null, at: null },
  inference: null,
  host: getHostContext(),
  scene: null,
  situation: null,
  lastSpeak: "",
  lastThinkAt: 0,
  thinkBusy: false,
  /** Accumulated sensor/lifecycle signal names for the next model turn. */
  pendingSignals: [],
  /** Observations from the last actions[] execution — consumed next turn. */
  toolResults: [],
  /** Last discarded model output — observation for the next turn. */
  lastParseError: null,
  started: false,
  activity: {
    page: null,
    file: null,
    typed: null,
    clipboard: null,
    selection: null,
    a11y: null,
    windows: [],
    recent_files: [],
    open_files: [],
    idle: null,
  },
  recentActivity: [],
};

function sceneFromFocus(focus, inference) {
  const hc = humanContent();
  return {
    app_guess: focus.app || null,
    window_title: focus.title || null,
    activity: focus.app || "",
    path_hint: inference?.path_hint || null,
    file_hint: inference?.file_hint || null,
    title_segments: inference?.title_segments || [],
    url: inference?.url || hc.page || null,
    file: inference?.file || hc.file || null,
    typed_excerpt: hc.typed || null,
    selection_excerpt: hc.sel || null,
    clipboard_excerpt: hc.clip || null,
    a11y_excerpt: hc.a11y || null,
    open_files: (state.activity.open_files || []).slice(0, IO.openFiles),
    windows: (state.activity.windows || []).slice(0, IO.windowsMax),
    signals: inference?.signals || [],
  };
}

function pushSignals(...sigs) {
  for (const raw of sigs) {
    const parts =
      typeof raw === "string" && raw.includes("+")
        ? raw.split("+")
        : [raw];
    for (const part of parts) {
      const s = String(part || "").trim();
      if (!s) continue;
      if (!state.pendingSignals.includes(s)) state.pendingSignals.push(s);
    }
  }
  void drainTurn();
}

function assessSituation(scene, focus, signals) {
  const events = (Array.isArray(signals) ? signals : [signals])
    .flatMap((s) => String(s || "").split("+"))
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    app: focus?.app || scene?.app_guess || "",
    title: focus?.title || scene?.window_title || "",
    activity: scene?.activity || "",
    signals: events,
    events,
    idle: state.activity.idle || null,
  };
}

export function noteFocus(focus) {
  const app = String(focus?.app ?? "").trim();
  const title = String(focus?.title ?? "").trim();
  const changed = app !== state.focus.app || title !== state.focus.title;
  state.focus = {
    app,
    title,
    pid: focus?.pid ?? null,
    workspace: focus?.workspace ?? null,
    at: new Date().toISOString(),
  };
  state.host = getHostContext();
  state.inference = inferFromTitle(state.focus.app, state.focus.title);
  state.scene = sceneFromFocus(state.focus, state.inference);
  state.situation = assessSituation(state.scene, state.focus, "focus");

  if (changed && (app || title)) {
    appendEpisode({
      type: "pc_focus",
      app,
      title,
    });
  }
  return { changed, focus: state.focus, inference: state.inference };
}

/**
 * Full activity stream from sense (Linux + Windows + macOS).
 * Raw ingest — no noise classifiers. Idle is stored only (no idle/active turns).
 */
export function noteActivity(payload = {}) {
  const focus = payload.focus || null;
  const skip = Boolean(focus?.skip);
  const events = [];

  if (focus && !skip && (focus.app || focus.title)) {
    const focusResult = noteFocus({
      app: focus.app,
      title: focus.title,
      pid: focus.pid,
    });
    if (focusResult.changed) events.push("focus");
  }

  if (payload.page?.url) {
    const url = String(payload.page.url);
    if (url !== state.activity.page?.url) {
      state.activity.page = {
        url,
        title: String(payload.page.title || "").slice(0, IO.windowTitle),
      };
      appendEpisode({
        type: "pc_page",
        url,
        title: state.activity.page.title,
      });
      events.push("page");
    }
  }

  if (payload.file?.path) {
    const path = String(payload.file.path);
    if (path !== state.activity.file?.path) {
      state.activity.file = {
        path,
        name: String(payload.file.name || "").slice(0, IO.fileHint),
      };
      appendEpisode({
        type: "pc_file",
        path,
        name: state.activity.file.name,
      });
      events.push("file");
    }
  }

  if (payload.typed?.text && !payload.typed.password_field) {
    const text = String(payload.typed.text).slice(0, IO.a11yValue);
    const app = payload.typed.app || focus?.app || "";
    const changed =
      text !== state.activity.typed?.text || app !== state.activity.typed?.app;
    state.activity.typed = {
      text,
      idle_ms: payload.typed.idle_ms ?? null,
      app,
    };
    if (changed) {
      appendEpisode({
        type: "pc_typed",
        app,
        text: text.slice(0, IO.a11yValue),
        idle_ms: state.activity.typed.idle_ms,
      });
      events.push("typed");
    }
  }

  if (payload.clipboard?.text) {
    const text = String(payload.clipboard.text).slice(0, IO.clipboardRaw);
    if (text !== state.activity.clipboard?.text) {
      state.activity.clipboard = { text };
      appendEpisode({
        type: "pc_clipboard",
        text: text.slice(0, IO.clipboardRaw),
      });
      events.push("clipboard");
    }
  }

  if (payload.selection?.text) {
    const text = String(payload.selection.text).slice(0, IO.clipboardRaw);
    if (text !== state.activity.selection?.text) {
      state.activity.selection = {
        text,
        source: payload.selection.source || "primary",
      };
      appendEpisode({
        type: "pc_selection",
        text: text.slice(0, IO.clipboardRaw),
        source: state.activity.selection.source,
      });
      events.push("selection");
    }
  }

  if (
    payload.a11y &&
    (payload.a11y.name || payload.a11y.value || payload.a11y.selection)
  ) {
    const rawValue = payload.a11y.password_field
      ? ""
      : String(payload.a11y.value || "").slice(0, IO.a11yValue);
    const rawSel = payload.a11y.password_field
      ? ""
      : String(payload.a11y.selection || "").slice(0, IO.a11ySelection);
    const next = {
      name: String(payload.a11y.name || "").slice(0, IO.a11yName),
      role: String(payload.a11y.role || "").slice(0, IO.a11yRole),
      value: rawValue,
      selection: rawSel,
      password_field: Boolean(payload.a11y.password_field),
    };
    const changed =
      next.value !== state.activity.a11y?.value ||
      next.selection !== state.activity.a11y?.selection ||
      next.name !== state.activity.a11y?.name;
    state.activity.a11y = next;
    if (changed && (next.value || next.selection)) {
      appendEpisode({
        type: "pc_a11y",
        name: next.name,
        role: next.role,
        value: next.value.slice(0, IO.a11yValue),
        selection: next.selection.slice(0, IO.a11ySelection),
      });
      events.push("a11y");
    }
  }

  if (Array.isArray(payload.windows)) {
    const next = packWindows(payload.windows);
    const prev = state.activity.windows || [];
    const winKey = (w) => `${w.app}\0${w.title}`;
    const nextSet = [...new Set(next.map(winKey))].sort().join("\n");
    const prevSet = [...new Set(prev.map(winKey))].sort().join("\n");
    const changed = nextSet !== prevSet;
    state.activity.windows = next;
    if (changed && next.length) {
      const host = getHostContext();
      appendEpisode({
        type: "pc_windows",
        clock: host.local_clock,
        date: host.local_date,
        windows: next.map((w) => ({ app: w.app, title: w.title })),
      });
      events.push("windows");
    }
  }

  if (Array.isArray(payload.recent_files) && payload.recent_files.length) {
    const next = payload.recent_files.map(String).slice(0, IO.recentFiles);
    const prev = state.activity.recent_files || [];
    const changed =
      next.length !== prev.length || next.some((p, i) => p !== prev[i]);
    state.activity.recent_files = next;
    if (changed) {
      appendEpisode({
        type: "pc_recent",
        files: next.slice(0, IO.recentFiles),
      });
      events.push("recent");
    }
  }

  if (Array.isArray(payload.open_files)) {
    const next = payload.open_files.map(String).slice(0, IO.openFiles);
    const prev = state.activity.open_files || [];
    const changed =
      next.length !== prev.length || next.some((p, i) => p !== prev[i]);
    state.activity.open_files = next;
    if (changed && next.length) {
      appendEpisode({
        type: "pc_open_files",
        files: next.slice(0, IO.openFiles),
      });
      events.push("open_files");
    }
  }

  if (payload.idle && typeof payload.idle === "object") {
    // Sense sends input_ms / quiet_ms only — store raw, no idle/active turns.
    state.activity.idle = {
      input_ms:
        payload.idle.input_ms == null ? null : Number(payload.idle.input_ms),
      quiet_ms:
        payload.idle.quiet_ms == null ? null : Number(payload.idle.quiet_ms),
    };
  }

  if (payload.inference) {
    state.inference = {
      ...state.inference,
      ...payload.inference,
    };
  }

  state.scene = sceneFromFocus(state.focus, state.inference);
  state.recentActivity = [
    ...state.recentActivity,
    { at: payload.at || new Date().toISOString(), events },
  ];

  if (events.length && !skip) {
    pushSignals(...events);
  }

  return { ok: true, events, focus: state.focus, activity: state.activity };
}

export function nudge() {
  appendEpisode({ type: "nudge", source: "orb_click" });
  state.host = getHostContext();
  pushSignals("nudge");
}

async function drainTurn() {
  if (state.thinkBusy || !state.pendingSignals.length) return;

  const signals = state.pendingSignals.splice(0);
  const toolResults = state.toolResults;
  state.toolResults = [];
  state.thinkBusy = true;
  state.lastThinkAt = Date.now();

  const situation = assessSituation(state.scene, state.focus, signals);
  state.situation = situation;

  try {
    const world = getWorldSnapshot();
    const intent = getIntent();
    state.host = getHostContext();
    let decision;
    try {
      decision = await thinkAlive({
        world,
        lastSpeak: state.lastSpeak,
        focus: state.focus,
        inference: state.inference,
        host: state.host,
        situation,
        signals,
        toolResults,
        intent,
        parseError: state.lastParseError,
      });
    } catch (err) {
      console.error("[companion:think-llm]", err.message);
      decision = null;
      state.lastParseError = {
        finish: "error",
        incomplete: true,
        raw: String(err.message || err),
      };
    }

    // Invalid / failed model turn: keep prior orb state (no fake silence).
    if (!decision) {
      // Preserve unconsumed tool results if the model failed this tick.
      if (toolResults.length && !state.toolResults.length) {
        state.toolResults = toolResults;
      }
      // Surface parse failure as a signal — model decides how to recover.
      pushSignals("parse_error");
      return;
    }

    const learned = applyLearn(decision.learn);
    if (learned.knowsNew || learned.knowsUpdated || learned.user) {
      console.log(
        `[companion:learn] new=${learned.knowsNew} updated=${learned.knowsUpdated} rejected=${learned.knowsRejected} user=${learned.user}`,
      );
    } else if (learned.knowsRejected) {
      console.log(`[companion:learn] rejected=${learned.knowsRejected}`);
    }

    if (decision.intent && typeof decision.intent === "object") {
      applyIntent(decision.intent);
    }

    if (decision.face) setFace(decision.face);

    if (!decision.silence && decision.speak) {
      state.lastSpeak = decision.speak;
      setCaption(decision.speak);
      appendEpisode({
        type: "spoke",
        text: decision.speak,
        face: decision.face || orbUi.face,
      });
    }

    if (decision.actions?.length) {
      const results = await executeActions(decision.actions);
      state.toolResults = results;
      setLastOutcome({
        at: new Date().toISOString(),
        actions: decision.actions,
        results: results.map((r) => ({
          tool: r.tool,
          ok: r.ok,
          error: r.error || null,
        })),
      });
      const okN = results.filter((r) => r.ok).length;
      console.log(
        `[companion:tools] ${okN}/${results.length} ok ← ${decision.actions.map((a) => a.tool).join(",")}`,
      );
      pushSignals("tool_result");
    }
  } catch (err) {
    console.error("[companion:think]", err.message);
  } finally {
    state.thinkBusy = false;
    if (state.pendingSignals.length) void drainTurn();
  }
}

export function startBrain() {
  if (state.started) return;
  state.started = true;
  getUserProfile();
  console.log(
    `companion brain: event-driven · tools=${TOOL_CATALOG.length}`,
  );
  // Think on boot + sensor/nudge/tool/parse signals — no wall-clock think timer.
  pushSignals("boot");
}

export function getStatus() {
  return {
    focus: state.focus,
    inference: state.inference,
    host: state.host,
    scene: state.scene,
    situation: state.situation,
    activity: {
      page: state.activity.page,
      file: state.activity.file,
      typed: state.activity.typed
        ? {
            ...state.activity.typed,
            text: String(state.activity.typed.text).slice(0, IO.a11yValue),
          }
        : null,
      has_clipboard: Boolean(state.activity.clipboard?.text),
      a11y: state.activity.a11y
        ? {
            name: state.activity.a11y.name,
            role: state.activity.a11y.role,
            has_value: Boolean(state.activity.a11y.value),
          }
        : null,
      idle: state.activity.idle,
      recent_files: state.activity.recent_files?.slice(0, IO.recentFiles),
      open_files: state.activity.open_files?.slice(0, IO.openFiles),
    },
    lastSpeak: state.lastSpeak,
    thinkBusy: state.thinkBusy,
    pendingSignals: [...state.pendingSignals],
    toolResultsPending: state.toolResults.length,
    intent: getIntent(),
    user: getUserProfile(),
    gaps: getWorldSnapshot().gaps,
  };
}

export function getUiState() {
  const orb = getOrbState();
  const user = getUserProfile();
  const world = getWorldSnapshot();
  return {
    face: orb.face,
    caption: orb.caption,
    balloon: orb.caption || "",
    focus: state.focus,
    busy: state.thinkBusy,
    user_name: user.name || null,
    gaps: world.gaps || [],
    orb_size: {
      width: ORB.width,
      height: ORB.height,
      balloon_height: ORB.balloonHeight,
    },
    scene_digest: state.scene
      ? {
          app: state.scene.app_guess,
          activity: state.scene.activity,
          url: state.scene.url,
          file: state.scene.file,
          title_segments: state.scene.title_segments,
        }
      : null,
    knows: world.knows,
  };
}

