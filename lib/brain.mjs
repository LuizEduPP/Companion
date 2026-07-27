import { readFileSync } from "node:fs";
import { config } from "./config.mjs";
import { inferFromTitle } from "./sense/infer.mjs";
import { packWindows, IO } from "./sense/util.mjs";
import {
  appendEpisode,
  recentEpisodes,
  getHostContext,
  applyLearn,
  getWorldSnapshot,
  getUserProfile,
  topGap,
} from "./store.mjs";

/* ── moods (keep in sync with public/avatar-engine.js EMOTIONS keys) ── */

const EMOTIONS = Object.freeze([
  "idle",
  "listening",
  "thinking",
  "speak",
  "focused",
  "happy",
  "laugh",
  "excited",
  "wink",
  "smug",
  "love",
  "shy",
  "curious",
  "sad",
  "tired",
  "sleepy",
  "annoyed",
  "angry",
  "disgust",
  "confused",
  "scared",
  "surprised",
]);

const ALLOWED = new Set(EMOTIONS);

/** Material sensor events that schedule a model turn. Idle is stored only. */
const THINK_MATERIAL = new Set([
  "page",
  "file",
  "typed",
  "clipboard",
  "selection",
  "a11y",
  "focus",
  "open_files",
]);

function normalizeEmotion(raw, fallback = "idle") {
  const name = String(raw || "").trim();
  return ALLOWED.has(name) ? name : fallback;
}

/* ── orb UI state ─────────────────────────────────────────────────── */

const intent = {
  mood: "idle",
  caption: "",
};

function setEmotion(mood) {
  intent.mood = normalizeEmotion(mood, "idle");
}

function setCaption(text) {
  intent.caption = String(text ?? "").trim();
}

export function getOrbState() {
  return {
    emotion: intent.mood,
    caption: intent.caption,
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
  const emotionRaw = raw.emotion ?? learn.emotion;
  if ("emotion" in learn || "focus" in learn) {
    const { emotion: _e, focus: _f, ...rest } = learn;
    learn = rest;
  }
  const cleanLearn = {};
  if (learn.user && typeof learn.user === "object") cleanLearn.user = learn.user;
  const knowsList = coerceKnowsList(learn.knows);
  if (knowsList.length) cleanLearn.knows = knowsList;

  const speak =
    typeof raw.speak === "string" ? raw.speak.trim() || null : null;
  return {
    silence: !speak,
    speak,
    emotion: normalizeEmotion(emotionRaw, "idle"),
    learn: cleanLearn,
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

function signalFingerprint() {
  const hc = humanContent();
  const wins = windowsForModel(state.activity.windows)
    .map((w) => `${w.app}|${w.title}`)
    .sort()
    .join(";");
  return [
    `${state.focus?.app || ""}|${state.focus?.title || ""}`,
    hc.clip || "",
    hc.sel || "",
    hc.typed || "",
    hc.page || "",
    hc.file || "",
    hc.a11y || "",
    wins,
  ].join("\n");
}

function normalizeSpeakKey(text) {
  return String(text || "").trim().toLowerCase();
}

async function thinkAlive({
  world,
  episodes,
  lastSpeak,
  focus,
  inference,
  situation,
  nudge,
  reason,
  host,
}) {
  // Policy lives only in prompts/companion.md — this turn is pure sensor/memory JSON.
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
    knows: world.knows ?? [],
    episodes: episodes ?? [],
    focus,
    inference,
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
      reason,
      nudge: Boolean(nudge),
      autonomous: true,
      last_balloon: lastSpeak || null,
      top_gap: situation?.top_gap || null,
      app: situation?.app || "",
      title: situation?.title || "",
      events: situation?.events || [],
    },
    emotions: EMOTIONS,
  };

  const { content, finish } = await chatCompletions({
    model: config.chatModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });

  const parsed = parseJsonObject(content);
  if (parsed) return normalizeDecision(parsed);

  console.warn(
    `[companion:think-llm] invalid JSON from model → silence (finish=${finish}):`,
    String(content).slice(0, 240),
  );
  return {
    silence: true,
    speak: null,
    emotion: "idle",
    learn: {},
  };
}

/* ── brain ────────────────────────────────────────────────────────── */

const state = {
  focus: { app: "", title: "", workspace: null, at: null },
  inference: null,
  host: getHostContext(),
  scene: null,
  situation: null,
  lastSpeak: "",
  lastSpokeAt: 0,
  lastThinkAt: 0,
  lastThinkFingerprint: "",
  thinkBusy: false,
  pendingTurn: null,
  awaitingUser: false,
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
    project_guess: inference?.project_guess || null,
    path_hint: inference?.path_hint || null,
    file_hint: inference?.file_hint || null,
    url: inference?.url || hc.page || null,
    file: inference?.file || hc.file || null,
    kind: inference?.kind || state.focus.kind || "other",
    typed_excerpt: hc.typed || null,
    selection_excerpt: hc.sel || null,
    clipboard_excerpt: hc.clip || null,
    a11y_excerpt: hc.a11y || null,
    open_files: (state.activity.open_files || []).slice(0, IO.openFiles),
    windows: (state.activity.windows || []).slice(0, IO.windowsMax),
    signals: inference?.signals || [],
  };
}

function scheduleTurn(reason) {
  if (!state.pendingTurn) state.pendingTurn = { reason, at: Date.now() };
  else if (reason === "nudge" || state.pendingTurn.reason !== "nudge") {
    state.pendingTurn.reason = reason;
  }
  void drainTurn();
}

function assessSituation(scene, focus, reason) {
  const gap = topGap();
  const events = [];
  if (reason === "focus") events.push("focus_change");
  if (reason === "nudge") events.push("nudge");
  if (reason === "boot") events.push("boot");
  if (reason === "typed") events.push("typed");
  if (gap) events.push("profile_gap");
  return {
    app: focus?.app || scene?.app_guess || "",
    title: focus?.title || scene?.window_title || "",
    activity: scene?.activity || "",
    project_guess: scene?.project_guess || "",
    events,
    top_gap: gap,
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
    kind: focus?.kind || state.focus.kind || "other",
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
      kind: state.focus.kind,
      project_guess: state.inference?.project_guess || null,
    });
    scheduleTurn("focus");
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
      kind: focus.kind,
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

  const material = events.some((e) => THINK_MATERIAL.has(e));
  if (material && !skip) {
    const reason = events.includes("typed") ? "typed" : "focus";
    scheduleTurn(reason);
  }

  return { ok: true, events, focus: state.focus, activity: state.activity };
}

export function nudge() {
  appendEpisode({ type: "nudge", source: "orb_click" });
  state.host = getHostContext();
  state.awaitingUser = false;
  scheduleTurn("nudge");
}

/** @deprecated use nudge */
export const enqueueNudge = nudge;

async function drainTurn() {
  if (state.thinkBusy || !state.pendingTurn) return;

  const turn = state.pendingTurn;
  state.pendingTurn = null;

  // Unique mechanical gate: same fingerprint → skip, except timed turns.
  const fp = signalFingerprint();
  const timed = turn.reason === "nudge" || turn.reason === "boot";
  if (!timed && fp && fp === state.lastThinkFingerprint) {
    if (state.pendingTurn) void drainTurn();
    return;
  }

  state.thinkBusy = true;
  state.lastThinkAt = Date.now();
  state.lastThinkFingerprint = fp;
  state.awaitingUser = false;
  setEmotion("thinking");

  const reason = turn.reason;
  const nudged = reason === "nudge";
  const situation = assessSituation(state.scene, state.focus, reason);
  state.situation = situation;

  try {
    const world = getWorldSnapshot();
    state.host = getHostContext();
    let decision;
    try {
      decision = await thinkAlive({
        world,
        episodes: recentEpisodes(),
        lastSpeak: state.lastSpeak,
        focus: state.focus,
        inference: state.inference,
        host: state.host,
        situation,
        nudge: nudged,
        reason,
      });
    } catch (err) {
      console.error("[companion:think-llm]", err.message);
      decision = {
        silence: true,
        speak: null,
        emotion: "idle",
        learn: {},
      };
    }

    // Exact duplicate of last balloon → silence (no fuzzy similarity).
    if (
      decision.speak &&
      state.lastSpeak &&
      normalizeSpeakKey(decision.speak) === normalizeSpeakKey(state.lastSpeak)
    ) {
      decision = {
        ...decision,
        silence: true,
        speak: null,
        emotion: "idle",
      };
    }

    const learned = applyLearn(decision.learn);
    if (learned.knowsNew || learned.knowsUpdated || learned.user) {
      console.log(
        `[companion:learn] new=${learned.knowsNew} updated=${learned.knowsUpdated} rejected=${learned.knowsRejected} user=${learned.user}`,
      );
    } else if (learned.knowsRejected) {
      console.log(`[companion:learn] rejected=${learned.knowsRejected}`);
    }

    if (!decision.silence && decision.speak) {
      state.lastSpeak = decision.speak;
      state.lastSpokeAt = Date.now();
      setCaption(decision.speak);
      setEmotion(decision.emotion || "speak");
      appendEpisode({
        type: "spoke",
        text: decision.speak,
        emotion: decision.emotion,
      });
      state.awaitingUser = false;
    } else {
      // Silence: caption stays until replaced, or clear now.
      setCaption("");
      if (decision.emotion) setEmotion(decision.emotion);
      else setEmotion("idle");
    }
  } catch (err) {
    console.error("[companion:think]", err.message);
  } finally {
    state.thinkBusy = false;
    if (state.pendingTurn) void drainTurn();
  }
}

export function startBrain() {
  if (state.started) return;
  state.started = true;
  getUserProfile();
  console.log("companion brain: observe+learn · fingerprint gate only");
  queueMicrotask(() => {
    if (!state.thinkBusy && !state.pendingTurn) scheduleTurn("boot");
  });
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
    pendingTurn: state.pendingTurn,
    awaitingUser: state.awaitingUser,
    user: getUserProfile(),
    gaps: getWorldSnapshot().gaps,
  };
}

/** @deprecated use getStatus */
export const brainStatus = getStatus;

export function getUiState() {
  const orb = getOrbState();
  const user = getUserProfile();
  return {
    ...orb,
    balloon: orb.caption || "",
    focus: state.focus,
    busy: state.thinkBusy,
    user_name: user.name || null,
    gap: topGap(user),
    orb_size: {
      width: config.orb.width,
      height: config.orb.height,
      balloon_height: config.orb.balloonHeight,
    },
    scene_digest: state.scene
      ? {
          app: state.scene.app_guess,
          activity: state.scene.activity,
          project: state.scene.project_guess,
          url: state.scene.url,
          file: state.scene.file,
          kind: state.scene.kind,
        }
      : null,
    knows: getWorldSnapshot().knows,
  };
}

export function getMemorySnapshot() {
  return {
    user: getUserProfile(),
    world: getWorldSnapshot(),
    episodes: recentEpisodes(),
    focus: state.focus,
    inference: state.inference,
    lastSpeak: state.lastSpeak,
    activity: {
      page: state.activity.page,
      file: state.activity.file,
      typed: state.activity.typed,
      clipboard: state.activity.clipboard,
      selection: state.activity.selection,
      a11y: state.activity.a11y,
      windows: windowsForModel(state.activity.windows),
      open_files: state.activity.open_files,
      recent_files: state.activity.recent_files,
      idle: state.activity.idle,
    },
  };
}
