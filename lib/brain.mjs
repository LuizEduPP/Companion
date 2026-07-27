import { readFileSync } from "node:fs";
import { config } from "./config.mjs";
import { inferFromTitle } from "./sense/infer.mjs";
import {
  UNKNOWN_APP,
  COMPANION_APP,
  isInfraNoise,
} from "./sense/util.mjs";
import {
  appendEpisode,
  recentEpisodes,
  getHostContext,
  applyLearn,
  getWorldSnapshot,
  getUserProfile,
  topGap,
} from "./store.mjs";

/* ── moods ────────────────────────────────────────────────────────── */

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

function normalizeEmotion(raw, fallback = "idle") {
  const name = String(raw || "").trim();
  return ALLOWED.has(name) ? name : fallback;
}

const EMOTION_PROMPT_LIST = EMOTIONS.join(",");

/* ── orb UI state ─────────────────────────────────────────────────── */

/**
 * Emotion + balloon caption for the orb.
 * Face animation runs in the overlay (avatar-engine emotion loops).
 */
const intent = {
  mood: "idle",
  caption: "",
};
let emotionChangedAt = 0;
const EMOTION_HOLD_MS = 10000;

function setEmotion(mood) {
  const next = normalizeEmotion(mood, "idle");
  if (next === intent.mood) return;
  const held = Date.now() - emotionChangedAt < EMOTION_HOLD_MS;
  // Soft hold: avoid brutal flips every think. Speak may interrupt.
  if (held && next !== "speak" && intent.mood !== "idle") return;
  if (held && intent.mood === "speak" && next === "idle") {
    // Allow settling from speak → idle after half hold.
    if (Date.now() - emotionChangedAt < EMOTION_HOLD_MS / 2) return;
  }
  intent.mood = next;
  emotionChangedAt = Date.now();
}

function setCaption(text) {
  intent.caption = String(text ?? "").slice(0, 160);
}

function getOrbState() {
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
  // Truncated fence: ```json\n{... without closing ```
  s = s.replace(/^```(?:json|JSON)?\s*/i, "").replace(/```$/i, "").trim();
  return s;
}

function balanceJsonSlice(slice) {
  let s = String(slice ?? "").trim();
  // Drop trailing incomplete key/value fragments from truncation.
  s = s.replace(/,\s*"[^"]*$/u, "");
  s = s.replace(/,\s*"[A-Za-z0-9_]+"\s*:\s*"[^"]*$/u, "");
  s = s.replace(/,\s*"[A-Za-z0-9_]+"\s*:\s*$/u, "");
  s = s.replace(/,\s*$/u, "");

  let inStr = false;
  let esc = false;
  let braces = 0;
  let brackets = 0;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") braces += 1;
    else if (ch === "}") braces -= 1;
    else if (ch === "[") brackets += 1;
    else if (ch === "]") brackets -= 1;
  }
  if (inStr) s += '"';
  while (brackets > 0) {
    s += "]";
    brackets -= 1;
  }
  while (braces > 0) {
    s += "}";
    braces -= 1;
  }
  return s;
}

/** Tiny models often emit JS-object literals (unquoted keys/values). */
function repairLooseJson(text) {
  let s = String(text ?? "");
  let out = "";
  let inStr = false;
  let quote = null;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        esc = true;
        continue;
      }
      if (ch === quote) {
        out += '"';
        inStr = false;
        quote = null;
        continue;
      }
      if (ch === '"' && quote === "'") {
        out += '\\"';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      out += '"';
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const rest = s.slice(i);
      const asKey = rest.match(/^([A-Za-z_][\w]*)(\s*:)/);
      if (asKey) {
        out += `"${asKey[1]}"${asKey[2]}`;
        i += asKey[0].length - 1;
        continue;
      }
      const asWord = rest.match(/^([A-Za-z_][\w]*)/);
      if (asWord) {
        const word = asWord[1];
        out +=
          word === "true" || word === "false" || word === "null"
            ? word
            : `"${word}"`;
        i += word.length - 1;
        continue;
      }
    }
    out += ch;
  }
  // Drop orphan tokens that are not key:value (e.g. `{a:b, orphan}`).
  out = out.replace(/,(\s*"[^"]*")\s*(?=[}\],])/g, "");
  return out.replace(/,\s*([}\]])/g, "$1");
}

function parseJsonObject(text) {
  const raw = stripMarkdownFences(text);
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

  const slice = end >= start ? raw.slice(start, end + 1) : raw.slice(start);
  const candidates = [
    slice,
    balanceJsonSlice(slice),
    repairLooseJson(slice),
    balanceJsonSlice(repairLooseJson(slice)),
  ];

  for (const chunk of candidates) {
    try {
      const parsed = JSON.parse(chunk);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

async function chatCompletions({ model, messages, temperature = 0.3 }) {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`chat failed ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message ?? {};
  // Gemma reasoning builds often put JSON in content (fenced/truncated)
  // and/or reasoning_content — try each until one parses.
  const blobs = [msg.content, msg.reasoning_content, msg.reasoning]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);
  if (!blobs.length) throw new Error("empty model content");

  for (const blob of blobs) {
    if (parseJsonObject(blob)) return blob;
  }
  return blobs[0];
}

function decisionFromPlainText(text) {
  const speak = sanitizeSpeak(
    String(text ?? "")
      .replace(/^```(?:json|JSON)?\s*/i, "")
      .replace(/```$/i, "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 160),
  );
  if (!speak || speak.startsWith("{")) return null;
  return {
    silence: false,
    speak,
    emotion: "idle",
    learn: {},
  };
}

function normalizeDecision(parsed) {
  const raw = parsed && typeof parsed === "object" ? parsed : {};
  let learn =
    raw.learn && typeof raw.learn === "object" && !Array.isArray(raw.learn)
      ? { ...raw.learn }
      : {};
  const emotionRaw = raw.emotion ?? learn.emotion;
  if ("emotion" in learn || "focus" in learn) {
    const { emotion: _e, focus: _f, ...rest } = learn;
    learn = rest;
  }
  const cleanLearn = {};
  if (learn.user && typeof learn.user === "object") cleanLearn.user = learn.user;
  if (Array.isArray(learn.knows)) {
    const knows = [];
    for (const item of learn.knows) {
      if (typeof item === "string") knows.push(item);
      else if (item?.text) knows.push(String(item.text));
    }
    if (knows.length) cleanLearn.knows = knows;
  }

  let speak =
    typeof raw.speak === "string" ? sanitizeSpeak(raw.speak) : null;
  // If the model wrote a balloon, that is presence — do not mute via silence=true.
  const silence = !speak;
  return {
    silence,
    speak: speak || null,
    emotion: normalizeEmotion(emotionRaw, "idle"),
    learn: cleanLearn,
  };
}

function clipboardForModel(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (isInfraNoise(s)) return null;
  // Drop companion/infra noise so the model does not "learn" its own config.
  if (
    /\[(?:hot|brain|sense)\]|companion:think-llm|think JSON parse failed|companion (?:brain|sense|hot)|watching public\/ for orb|companion sense →|OPENAI_|COMPANION_/i.test(
      s,
    )
  ) {
    return null;
  }
  if (/^\s*\{[\s\S]*"silence"\s*:/.test(s)) return null;
  // Selection/clipboard of memory.json / episode dumps — ignore.
  if (/"episodes"\s*:/.test(s) && /"knows"\s*:/.test(s)) return null;
  if (/"type"\s*:\s*"pc_(focus|clipboard|selection|typed)"/.test(s)) return null;
  if (/pc_selection|pc_clipboard|project_guess/.test(s) && /\\n\s*\{/.test(s)) {
    return null;
  }
  if (s.length < 8) return null;
  // Escaped JSON fragments / code crumbs (e.g. u-g\",).
  if (/^[\\"'`{}\[\]:,\s\w.-]{1,24}$/.test(s) && /[\\"'{}[\],]/.test(s) && !/\s/.test(s)) {
    return null;
  }
  return s.slice(0, 500);
}

/** Focus on companion itself (orb / its terminal) — not a human topic. */
function isSelfFocus(focus) {
  const app = String(focus?.app || "").trim().toLowerCase();
  const title = String(focus?.title || "").trim().toLowerCase();
  if (app === COMPANION_APP) return true;
  if (app === "electron" && /companion\s*orb/.test(title)) return true;
  if (/companion\s*:/.test(title)) return true;
  if (/node-mainthread/.test(title) && /konsole|terminal/.test(title)) return true;
  return false;
}

/** Drop desktop chrome / self windows from the model payload. */
function windowsForModel(list) {
  return (list || [])
    .filter((w) => {
      const app = String(w?.app || "").toLowerCase();
      const title = String(w?.title || "").toLowerCase();
      if (app === "plasmashell" && /[aá]rea de trabalho|desktop/.test(title)) {
        return false;
      }
      if (app === "electron" && /companion\s*orb/.test(title)) return false;
      if (/companion\s*:/.test(title)) return false;
      return Boolean(app || title);
    })
    .map((w) => ({
      app: String(w?.app || "").slice(0, 80),
      title: String(w?.title || "").slice(0, 160),
    }))
    .slice(0, 12);
}

function signalFingerprint() {
  const wins = windowsForModel(state.activity.windows)
    .map((w) => `${w.app}|${w.title}`)
    .sort()
    .join(";");
  return [
    `${state.focus?.app || ""}|${state.focus?.title || ""}`,
    clipboardForModel(state.activity.clipboard?.text) || "",
    clipboardForModel(state.activity.selection?.text) || "",
    String(state.activity.typed?.text || "").slice(0, 120),
    state.activity.page?.url || "",
    state.activity.file?.path || "",
    wins,
  ].join("\n");
}

/** Drop interview / Q&A balloons — companion never asks the human. */
function sanitizeSpeak(text) {
  let speak = String(text ?? "").trim().slice(0, 160);
  if (!speak) return null;
  if (/unknown|undefined focus|sem t[ií]tulo|foco (indefinido|desconhecido)|missing title|sensing/i.test(speak)) {
    return null;
  }
  if (
    /\b(eis|outrossim|destarte|porquanto|heis de|indubitavelmente|porventura|outrora|hark|alas|thou|thee|forsooth|verily)\b/i.test(
      speak,
    )
  ) {
    return null;
  }
  if (
    /\?/.test(speak) ||
    /o que (voc[eê]|vc) (precisa|quer|vai|acha)|precisa fazer com|quer (que eu|fazer)|what do you (want|need)|how can i help|no que (posso|voc)|pra que isso|para que isso/i.test(
      speak,
    )
  ) {
    return null;
  }
  // Empty-presence filler the model loops on.
  if (
    /^(a )?tela (est[aá]|t[aá]|continua) quieta|tudo (tranquilo|parado|quieto)|esperando (o |a )?(pr[oó]ximo|pr[oó]xima)|s[oó] esperando/i.test(
      speak,
    )
  ) {
    return null;
  }
  return speak;
}

function isSensorThin(focus) {
  const app = String(focus?.app || "").trim().toLowerCase();
  const title = String(focus?.title || "").trim().toLowerCase();
  const emptyFocus =
    (!app || app === UNKNOWN_APP) && (!title || title === UNKNOWN_APP);
  if (!emptyFocus) return false;
  if (state.activity.page?.url || state.activity.file?.path) return false;
  if (state.activity.typed?.text) return false;
  if (clipboardForModel(state.activity.selection?.text)) return false;
  if (clipboardForModel(state.activity.clipboard?.text)) return false;
  if (state.activity.a11y?.value) return false;
  if ((state.activity.open_files || []).length) return false;
  return true;
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
  const system = [
    readFileSync(config.promptPath, "utf8"),
    "",
    "HARD OUTPUT RULE: reply with ONE raw JSON object only. First character must be `{`. No markdown. No prose outside JSON. Keys must be double-quoted.",
  ].join("\n");
  const userProf = world.user
    ? {
        name: world.user.name || "",
        locale: world.user.locale || "",
        notes: String(world.user.notes || "").slice(0, 200),
      }
    : {};
  const clock = host || getHostContext();
  const windows = windowsForModel(state.activity.windows);
  const clip = clipboardForModel(state.activity.clipboard?.text);
  const sel = clipboardForModel(state.activity.selection?.text);
  const typedText = state.activity.typed?.text
    ? String(state.activity.typed.text).slice(0, 800)
    : null;
  const thin = isSensorThin(focus);
  const user = [
    "Now:",
    JSON.stringify({
      clock: clock.local_clock || "",
      date: clock.local_date || "",
      weekday: clock.weekday || "",
      timezone: clock.timezone || "",
      label: clock.now || "",
    }),
    "Windows:",
    JSON.stringify(windows),
    "User:",
    JSON.stringify(userProf),
    "Gaps:",
    JSON.stringify((world.gaps ?? []).slice(0, 4)),
    "Knows:",
    JSON.stringify((world.knows ?? []).slice(-16)),
    "Episodes:",
    JSON.stringify((episodes ?? []).slice(-8)),
    "Focus:",
    JSON.stringify(focus),
    "Inference:",
    JSON.stringify(inference),
    "Activity:",
    JSON.stringify({
      page: state.activity.page,
      file: state.activity.file,
      typed: typedText ? { text: typedText } : null,
      selection: sel ? { text: sel } : null,
      clipboard: clip ? { text: clip } : null,
      open_files: (state.activity.open_files || []).slice(0, 10),
      windows,
      idle: state.activity.idle || null,
      a11y: state.activity.a11y
        ? {
            name: state.activity.a11y.name,
            role: state.activity.a11y.role,
            value: String(state.activity.a11y.value || "").slice(0, 400),
            selection: String(state.activity.a11y.selection || "").slice(0, 300),
          }
        : null,
    }),
    "Situation:",
    JSON.stringify({
      reason,
      nudge: Boolean(nudge),
      autonomous: true,
      sensor_thin: thin,
      app: situation?.app || "",
      title: situation?.title || "",
      events: situation?.events || [],
      interesting: Boolean(situation?.interesting),
      top_gap: situation?.top_gap || null,
    }),
    lastSpeak ? `Last balloon: ${lastSpeak}` : "",
    thin
      ? "Focus sensor may be unknown — do NOT narrate that. Prefer silence unless another signal is worth a take."
      : null,
    sel || clip || typedText
      ? "Content may be in selection/clipboard/typed — react with one short opinion if it is human content; silence only for infra/code crumbs. Never ask what they want to do with it."
      : null,
    !thin && windows.length
      ? "Windows/focus are real context — prefer one short casual take about what they are doing (app+title/time), not silence."
      : null,
    nudge
      ? "Nudge: speak one short casual take now in user locale (modern everyday speech). No questions."
      : "Autonomous turn: prefer a short presence take when there is concrete context (windows/focus/time/content). Silence only for empty/self/filler. Keep learning. Modern speech only. Never ask questions.",
    'Keys ONLY: silence,speak,emotion,learn. Double-quoted JSON.',
    'Speak example: {"silence":false,"speak":"facebook de noite assim só atrasa o que você tava fazendo.","emotion":"curious","learn":{"knows":["À noite costuma abrir o Facebook no Chrome."]}}',
    'Silent example: {"silence":true,"speak":null,"emotion":"idle","learn":{"knows":[]}}',
    "emotion one of: " + EMOTION_PROMPT_LIST,
    "START WITH {",
  ]
    .filter(Boolean)
    .join("\n");

  const content = await chatCompletions({
    model: config.chatModel,
    temperature: 0.35,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const parsed = parseJsonObject(content);
  if (parsed) return normalizeDecision(parsed);

  const plain = decisionFromPlainText(content);
  if (plain) {
    console.warn(
      "[companion:think-llm] plain text → balloon:",
      plain.speak.slice(0, 80),
    );
    return plain;
  }

  console.warn(
    "[companion:think-llm] unusable model output → silence:",
    String(content).slice(0, 120),
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
  wasIdle: false,
};

function sceneFromFocus(focus, inference) {
  return {
    app_guess: focus.app || null,
    window_title: focus.title || null,
    activity: focus.app || "",
    project_guess: inference?.project_guess || null,
    path_hint: inference?.path_hint || null,
    file_hint: inference?.file_hint || null,
    url: inference?.url || state.activity.page?.url || null,
    file: inference?.file || state.activity.file?.path || null,
    kind: inference?.kind || state.focus.kind || "other",
    typed_excerpt: state.activity.typed?.text
      ? String(state.activity.typed.text).slice(0, 400)
      : null,
    selection_excerpt: state.activity.selection?.text
      ? String(state.activity.selection.text).slice(0, 300)
      : null,
    clipboard_excerpt: state.activity.clipboard?.text
      ? String(state.activity.clipboard.text).slice(0, 200)
      : null,
    a11y_excerpt: state.activity.a11y?.value
      ? String(state.activity.a11y.value).slice(0, 300)
      : null,
    open_files: (state.activity.open_files || []).slice(0, 8),
    windows: (state.activity.windows || []).slice(0, 8),
    signals: inference?.signals || [],
  };
}

function focusIsInteresting(focus, inference) {
  if (isSelfFocus(focus)) return false;
  const app = String(focus?.app || "").trim().toLowerCase();
  if (app && app !== UNKNOWN_APP && app !== COMPANION_APP) return true;
  if (inference?.project_guess || inference?.file_hint || inference?.path_hint) {
    return true;
  }
  if (inference?.url || inference?.file) return true;
  if (state.activity.page?.url || state.activity.file?.path) return true;
  if (state.activity.typed?.text) return true;
  if (clipboardForModel(state.activity.selection?.text)) return true;
  if (clipboardForModel(state.activity.clipboard?.text)) return true;
  if (state.activity.a11y?.value && !isInfraNoise(state.activity.a11y.value)) {
    return true;
  }
  if ((state.activity.open_files || []).length) return true;
  const title = String(focus?.title || "").trim().toLowerCase();
  if (title && title !== UNKNOWN_APP) return true;
  return false;
}

function hasAnyActivitySignal() {
  if (focusIsInteresting(state.focus, state.inference)) return true;
  if (state.activity.typed?.text) return true;
  if (clipboardForModel(state.activity.selection?.text)) return true;
  if (state.activity.page?.url || state.activity.file?.path) return true;
  if (clipboardForModel(state.activity.clipboard?.text)) return true;
  if (state.activity.a11y?.value && !isInfraNoise(state.activity.a11y.value)) {
    return true;
  }
  if ((state.activity.open_files || []).length) return true;
  if (topGap()) return true;
  return false;
}

function shouldThinkOnFocus(focus, inference) {
  if (isSelfFocus(focus)) {
    // Only think when self-focus still carries real human content.
    return Boolean(
      clipboardForModel(state.activity.clipboard?.text) ||
        clipboardForModel(state.activity.selection?.text) ||
        state.activity.typed?.text ||
        state.activity.page?.url ||
        state.activity.file?.path,
    );
  }
  if (focusIsInteresting(focus, inference)) return true;
  if (state.activity.typed?.text || state.activity.page?.url || state.activity.file?.path) {
    return true;
  }
  if (
    clipboardForModel(state.activity.clipboard?.text) ||
    clipboardForModel(state.activity.selection?.text) ||
    (state.activity.a11y?.value && !isInfraNoise(state.activity.a11y.value))
  ) {
    return true;
  }
  return false;
}

function scheduleTurn(reason) {
  // Nudge wins over quieter reasons if something is already queued.
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
  if (reason === "proactive" || reason === "boot") events.push(reason);
  if (reason === "typed") events.push("typed");
  if (reason === "idle") events.push("pc_idle");
  if (gap) events.push("profile_gap");
  const interesting =
    events.length > 0 || focusIsInteresting(focus, state.inference);
  return {
    app: focus?.app || scene?.app_guess || "",
    title: focus?.title || scene?.window_title || "",
    activity: scene?.activity || "",
    project_guess: scene?.project_guess || "",
    events,
    top_gap: gap,
    interesting,
    idle: state.activity.idle || null,
  };
}

function absorbFocusLearning(_focus, _inference) {
  // Focus stays in episodes only — durable memory is compiled knows[].
}

export function noteFocus(focus) {
  const app = String(focus?.app ?? "").trim();
  const title = String(focus?.title ?? "").trim();
  const changed =
    app !== state.focus.app || title !== state.focus.title;
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
    absorbFocusLearning(state.focus, state.inference);
    if (shouldThinkOnFocus(state.focus, state.inference)) {
      scheduleTurn("focus");
    }
  }
  return { changed, focus: state.focus, inference: state.inference };
}

/**
 * Full activity stream from sense (Linux + Windows + macOS).
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
        title: String(payload.page.title || "").slice(0, 160),
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
        name: String(payload.file.name || "").slice(0, 160),
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
    const text = String(payload.typed.text).slice(0, 16000);
    if (isInfraNoise(text)) {
      /* companion terminal / hot-reload logs — do not memorize */
    } else {
      const app = payload.typed.app || focus?.app || "";
      const changed =
        text !== state.activity.typed?.text ||
        app !== state.activity.typed?.app;
      state.activity.typed = {
        text,
        idle_ms: payload.typed.idle_ms ?? null,
        app,
      };
      if (changed) {
        appendEpisode({
          type: "pc_typed",
          app,
          text: text.slice(0, 280),
          idle_ms: state.activity.typed.idle_ms,
        });
        events.push("typed");
      }
    }
  }

  if (payload.clipboard?.text) {
    const text = String(payload.clipboard.text).slice(0, 8000);
    if (!clipboardForModel(text) || isInfraNoise(text)) {
      if (state.activity.clipboard) state.activity.clipboard = null;
    } else if (text !== state.activity.clipboard?.text) {
      state.activity.clipboard = { text };
      appendEpisode({
        type: "pc_clipboard",
        text: text.slice(0, 280),
      });
      events.push("clipboard");
    }
  }

  if (payload.selection?.text) {
    const text = String(payload.selection.text).slice(0, 8000);
    if (!clipboardForModel(text) || isInfraNoise(text)) {
      if (state.activity.selection) state.activity.selection = null;
    } else if (text !== state.activity.selection?.text) {
      state.activity.selection = {
        text,
        source: payload.selection.source || "primary",
      };
      appendEpisode({
        type: "pc_selection",
        text: text.slice(0, 500),
        source: state.activity.selection.source,
      });
      events.push("selection");
    }
  }

  if (payload.a11y && (payload.a11y.name || payload.a11y.value || payload.a11y.selection)) {
    const rawValue = payload.a11y.password_field
      ? ""
      : String(payload.a11y.value || "").slice(0, 4000);
    const rawSel = payload.a11y.password_field
      ? ""
      : String(payload.a11y.selection || "").slice(0, 4000);
    if (isInfraNoise(rawValue) && isInfraNoise(rawSel || "x")) {
      /* ignore companion log terminals */
    } else {
      const next = {
        name: String(payload.a11y.name || "").slice(0, 200),
        role: String(payload.a11y.role || "").slice(0, 120),
        value: isInfraNoise(rawValue) ? "" : rawValue,
        selection: isInfraNoise(rawSel) ? "" : rawSel,
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
          value: next.value.slice(0, 280),
          selection: next.selection.slice(0, 200),
        });
        events.push("a11y");
      }
    }
  }

  if (Array.isArray(payload.windows)) {
    const next = payload.windows
      .map((w) => ({
        app: String(w?.app || "").slice(0, 80),
        title: String(w?.title || "").slice(0, 160),
        pid: w?.pid ?? null,
      }))
      .slice(0, 12);
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
      // Record only — window churn must not hammer the LLM.
      events.push("windows");
    }
  }

  if (Array.isArray(payload.recent_files) && payload.recent_files.length) {
    const next = payload.recent_files.map(String).slice(0, 12);
    const prev = state.activity.recent_files || [];
    const changed =
      next.length !== prev.length || next.some((p, i) => p !== prev[i]);
    state.activity.recent_files = next;
    if (changed) {
      appendEpisode({
        type: "pc_recent",
        files: next.slice(0, 8),
      });
      events.push("recent");
    }
  }

  if (Array.isArray(payload.open_files)) {
    const next = payload.open_files.map(String).slice(0, 16);
    const prev = state.activity.open_files || [];
    const changed =
      next.length !== prev.length || next.some((p, i) => p !== prev[i]);
    state.activity.open_files = next;
    if (changed && next.length) {
      appendEpisode({
        type: "pc_open_files",
        files: next.slice(0, 10),
      });
      events.push("open_files");
    }
  }

  if (payload.idle && typeof payload.idle === "object") {
    const next = {
      input_ms:
        payload.idle.input_ms == null ? null : Number(payload.idle.input_ms),
      quiet_ms: Number(payload.idle.quiet_ms ?? 0),
      threshold_ms: Number(payload.idle.threshold_ms ?? 60000),
      idle: Boolean(payload.idle.idle),
    };
    const was = state.wasIdle;
    state.activity.idle = next;
    if (next.idle && !was) {
      state.wasIdle = true;
      appendEpisode({
        type: "pc_idle",
        input_ms: next.input_ms,
        quiet_ms: next.quiet_ms,
        threshold_ms: next.threshold_ms,
      });
      events.push("idle");
    } else if (!next.idle && was) {
      state.wasIdle = false;
      appendEpisode({ type: "pc_active" });
      events.push("active");
    }
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
  ].slice(-40);

  const material = events.some((e) =>
    [
      "page",
      "file",
      "typed",
      "clipboard",
      "selection",
      "a11y",
      "focus",
      "open_files",
      "idle",
      "active",
    ].includes(e),
  );
  if (material && !skip) {
    if (
      events.includes("typed") ||
      events.includes("page") ||
      events.includes("file") ||
      events.includes("focus") ||
      events.includes("clipboard") ||
      events.includes("selection") ||
      events.includes("a11y") ||
      events.includes("open_files") ||
      events.includes("idle") ||
      events.includes("active") ||
      shouldThinkOnFocus(state.focus, state.inference)
    ) {
      const reason = events.includes("typed")
        ? "typed"
        : events.includes("idle")
          ? "idle"
          : "focus";
      scheduleTurn(reason);
    }
  }

  return { ok: true, events, focus: state.focus, activity: state.activity };
}

export function enqueueNudge() {
  appendEpisode({ type: "nudge", source: "orb_click" });
  state.host = getHostContext();
  state.awaitingUser = false;
  scheduleTurn("nudge");
}

async function drainTurn() {
  if (state.thinkBusy || !state.pendingTurn) return;

  const now = Date.now();
  if (now - state.lastThinkAt < config.thinkMinMs) {
    const wait = config.thinkMinMs - (now - state.lastThinkAt);
    setTimeout(() => {
      void drainTurn();
    }, wait);
    return;
  }

  const turn = state.pendingTurn;
  state.pendingTurn = null;

  // Same sensors as last think → skip (except nudge).
  const fp = signalFingerprint();
  if (turn.reason !== "nudge" && fp && fp === state.lastThinkFingerprint) {
    state.lastThinkAt = Date.now();
    return;
  }

  state.thinkBusy = true;
  state.lastThinkAt = Date.now();
  state.lastThinkFingerprint = fp;
  state.awaitingUser = false;

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
        scene: state.scene,
        world,
        episodes: recentEpisodes(24),
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

    // Nudge: never inject canned speech. If the model is silent, stay silent.
    if (nudged && (decision.silence || !decision.speak)) {
      decision = {
        ...decision,
        silence: true,
        speak: null,
        emotion: decision.emotion || "idle",
      };
    }

    // Hard cooldown: tiny models ignore "prefer silence".
    if (
      !nudged &&
      decision.speak &&
      config.speakMinMs > 0 &&
      state.lastSpokeAt &&
      Date.now() - state.lastSpokeAt < config.speakMinMs
    ) {
      decision = {
        ...decision,
        silence: true,
        speak: null,
      };
    }

    // Drop near-duplicate of last balloon.
    if (
      decision.speak &&
      state.lastSpeak &&
      decision.speak.toLowerCase().replace(/\s+/g, " ") ===
        state.lastSpeak.toLowerCase().replace(/\s+/g, " ")
    ) {
      decision = { ...decision, silence: true, speak: null };
    }

    applyLearn(decision.learn);

    if (decision.emotion) setEmotion(decision.emotion);

    if (!decision.silence && decision.speak) {
      state.lastSpeak = decision.speak;
      state.lastSpokeAt = Date.now();
      setCaption(decision.speak);
      appendEpisode({
        type: "spoke",
        text: decision.speak,
        emotion: decision.emotion,
      });
      state.awaitingUser = false;
    } else if (!state.lastSpeak) {
      setCaption("");
    }
  } catch (err) {
    console.error("[companion:think]", err.message);
  } finally {
    state.thinkBusy = false;
    if (state.pendingTurn) void drainTurn();
  }
}

let timer = null;
let proactiveTimer = null;

function maybeProactive() {
  if (state.thinkBusy || state.pendingTurn) return;
  if (config.proactiveMs <= 0) return;
  if (Date.now() - state.lastThinkAt < config.proactiveMs) return;
  // Autonomous background think whenever there is any signal or open gap.
  if (!hasAnyActivitySignal()) return;
  scheduleTurn("proactive");
}

export function startBrain() {
  if (timer) return;
  getUserProfile();
  console.log(
    `companion brain: observe+learn · proactive=${config.proactiveMs}ms`,
  );
  timer = setInterval(() => {
    if (state.pendingTurn && !state.thinkBusy) void drainTurn();
  }, 500);
  // Boot think: learn from first scene (may stay silent).
  setTimeout(() => {
    if (!state.thinkBusy && !state.pendingTurn) scheduleTurn("boot");
  }, 2500);
  if (config.proactiveMs > 0) {
    proactiveTimer = setInterval(maybeProactive, Math.min(5000, config.proactiveMs));
  }
}

export function brainStatus() {
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
        ? { ...state.activity.typed, text: String(state.activity.typed.text).slice(0, 200) }
        : null,
      has_clipboard: Boolean(state.activity.clipboard?.text),
      a11y: state.activity.a11y
        ? {
            name: state.activity.a11y.name,
            role: state.activity.a11y.role,
            has_value: Boolean(state.activity.a11y.value),
          }
        : null,
      recent_files: state.activity.recent_files?.slice(0, 6),
      open_files: state.activity.open_files?.slice(0, 6),
    },
    lastSpeak: state.lastSpeak,
    thinkBusy: state.thinkBusy,
    pendingTurn: state.pendingTurn,
    awaitingUser: state.awaitingUser,
    user: getUserProfile(),
    gaps: getWorldSnapshot().gaps,
  };
}

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
    knows: getWorldSnapshot().knows.slice(-8),
  };
}
