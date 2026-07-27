import { readFileSync } from "node:fs";
import { config } from "./config.mjs";
import { inferFromTitle } from "./sense/infer.mjs";
import {
  UNKNOWN_APP,
  COMPANION_APP,
  isInfraNoise,
  contentForModel,
  packWindows,
  orbTitle,
  LIMITS,
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
const EMOTION_PROMPT_LIST = EMOTIONS.join(",");
const CALM_EMOTIONS = new Set([
  "idle",
  "listening",
  "thinking",
  "focused",
  "curious",
  "shy",
]);

const THINK_MATERIAL = new Set([
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
]);

function normalizeEmotion(raw, fallback = "idle") {
  const name = String(raw || "").trim();
  return ALLOWED.has(name) ? name : fallback;
}

/* ── orb UI state ─────────────────────────────────────────────────── */

const intent = {
  mood: "idle",
  caption: "",
  captionUntil: 0,
};
let emotionChangedAt = 0;

function setEmotion(mood) {
  const next = normalizeEmotion(mood, "idle");
  if (next === intent.mood) return;
  const holdMs = config.emotionHoldMs;
  const held = Date.now() - emotionChangedAt < holdMs;
  if (held && next !== "speak" && intent.mood !== "idle") return;
  if (held && intent.mood === "speak" && next === "idle") {
    if (Date.now() - emotionChangedAt < holdMs / 2) return;
  }
  intent.mood = next;
  emotionChangedAt = Date.now();
}

function setCaption(text) {
  const caption = String(text ?? "").slice(0, LIMITS.speak);
  intent.caption = caption;
  intent.captionUntil = caption ? Date.now() + config.balloonMs : 0;
}

function clearCaptionIfExpired() {
  if (!intent.caption) return;
  if (intent.captionUntil && Date.now() >= intent.captionUntil) {
    intent.caption = "";
    intent.captionUntil = 0;
  }
}

function getOrbState() {
  clearCaptionIfExpired();
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

async function chatCompletions({ model, messages, temperature }) {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: config.chatMaxTokens,
    }),
    signal: AbortSignal.timeout(config.chatTimeoutMs),
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
      .slice(0, LIMITS.speak),
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

/** Focus on companion itself (orb / its terminal) — not a human topic. */
function isSelfFocus(focus) {
  const app = String(focus?.app || "").trim().toLowerCase();
  const title = String(focus?.title || "").trim().toLowerCase();
  const orb = orbTitle().toLowerCase();
  if (app === COMPANION_APP) return true;
  if (app === "electron" && title.includes(orb)) return true;
  if (title.includes(orb)) return true;
  if (/companion\s*:/.test(title)) return true;
  if (/node-mainthread/.test(title) && /konsole|terminal/.test(title)) return true;
  return false;
}

/** Drop desktop chrome / self windows from the model payload. */
function windowsForModel(list) {
  const orb = orbTitle().toLowerCase();
  return packWindows(list)
    .filter((w) => {
      const app = w.app.toLowerCase();
      const title = w.title.toLowerCase();
      if (app === "plasmashell" && /[aá]rea de trabalho|desktop/.test(title)) {
        return false;
      }
      if (app === "electron" && title.includes(orb)) return false;
      if (title.includes(orb) || /companion\s*:/.test(title)) return false;
      return true;
    })
    .map((w) => ({ app: w.app, title: w.title }));
}

function humanContent() {
  return {
    clip: contentForModel(state.activity.clipboard?.text),
    sel: contentForModel(state.activity.selection?.text),
    typed: state.activity.typed?.text
      ? String(state.activity.typed.text).slice(0, LIMITS.modelTyped)
      : null,
    page: state.activity.page?.url || null,
    file: state.activity.file?.path || null,
    a11y:
      state.activity.a11y?.value && !isInfraNoise(state.activity.a11y.value)
        ? state.activity.a11y.value
        : null,
    openFiles: (state.activity.open_files || []).length > 0,
  };
}

function hasHumanContent(hc = humanContent()) {
  return Boolean(
    hc.clip || hc.sel || hc.typed || hc.page || hc.file || hc.a11y || hc.openFiles,
  );
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
    String(hc.typed || "").slice(0, 120),
    hc.page || "",
    hc.file || "",
    wins,
  ].join("\n");
}

/** Drop interview / Q&A / filler / archaic / pure narration balloons. */
function sanitizeSpeak(text) {
  const speak = String(text ?? "").trim().slice(0, LIMITS.speak);
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
  if (
    /^(a )?tela (est[aá]|t[aá]|continua) quieta|tudo (tranquilo|parado|quieto)|esperando (o |a )?(pr[oó]ximo|pr[oó]xima)|s[oó] esperando/i.test(
      speak,
    )
  ) {
    return null;
  }
  // Pure desktop narration — naming the app/window is not understanding.
  if (
    /^(voc[eê]|vc) (est[aá]|t[aá]|continua) (no|na|em|usando|abrindo|vendo)\b/i.test(
      speak,
    ) ||
    /^(aberto|abrindo|usando|vendo|focado (no|na)|janela)\b/i.test(speak) ||
    /^(you('re| are)|looking at|opened|using)\b/i.test(speak)
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
  return !hasHumanContent();
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
  const hc = humanContent();
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
      typed: hc.typed ? { text: hc.typed } : null,
      selection: hc.sel ? { text: hc.sel } : null,
      clipboard: hc.clip ? { text: hc.clip } : null,
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
    "Knows are durable beliefs about the human — habits, preferences, tools, recurring patterns. Update learn.knows when evidence supports a lasting note; use [] if nothing durable. Never rephrase an existing Know. Never learn 'currently working on X' or companion brain/sense/orb meta.",
    thin
      ? "Focus sensor may be unknown — do NOT narrate that. Prefer silence unless another signal is worth an insight."
      : null,
    hc.sel || hc.clip || hc.typed
      ? "Content may be in selection/clipboard/typed — react with one short opinion/insight if it is human content; silence only for infra/code crumbs. Never ask what they want to do with it. Never restate the app name."
      : null,
    !thin && windows.length
      ? "Windows/focus are private context — infer intent or share a take about meaning/timing/habit. Do NOT narrate app+title. Silence if you would only name what is open."
      : null,
    nudge
      ? "Nudge: one short understanding take now in user locale (modern everyday speech). No questions. No app narration."
      : "Autonomous turn: speak only when you understand something (intent, pattern, opinion). Silence for empty/self/filler/pure narration. Always fill learn.knows ([] ok). Modern speech only. Never ask questions.",
    'Keys ONLY: silence,speak,emotion,learn. Double-quoted JSON.',
    'Speak example: {"silence":false,"speak":"parece que você tá no fluxo.","emotion":"curious","learn":{"knows":["Costuma entrar fundo no trabalho de noite."]}}',
    'Silent example: {"silence":true,"speak":null,"emotion":"idle","learn":{"knows":[]}}',
    "emotion one of: " + EMOTION_PROMPT_LIST,
    "START WITH {",
  ]
    .filter(Boolean)
    .join("\n");

  const content = await chatCompletions({
    model: config.chatModel,
    temperature: config.chatTemperature,
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
    typed_excerpt: hc.typed ? String(hc.typed).slice(0, 400) : null,
    selection_excerpt: hc.sel ? String(hc.sel).slice(0, 300) : null,
    clipboard_excerpt: hc.clip ? String(hc.clip).slice(0, 200) : null,
    a11y_excerpt: hc.a11y ? String(hc.a11y).slice(0, 300) : null,
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
  if (hasHumanContent()) return true;
  const title = String(focus?.title || "").trim().toLowerCase();
  if (title && title !== UNKNOWN_APP) return true;
  return false;
}

function hasAnyActivitySignal() {
  if (focusIsInteresting(state.focus, state.inference)) return true;
  if (hasHumanContent()) return true;
  if (topGap()) return true;
  return false;
}

function shouldThinkOnFocus(focus, inference) {
  if (isSelfFocus(focus)) return hasHumanContent();
  if (focusIsInteresting(focus, inference)) return true;
  return hasHumanContent();
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
        title: String(payload.page.title || "").slice(0, LIMITS.pageTitle),
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
        name: String(payload.file.name || "").slice(0, LIMITS.fileName),
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
    const text = String(payload.typed.text).slice(0, LIMITS.typed);
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
          text: text.slice(0, LIMITS.episodeText),
          idle_ms: state.activity.typed.idle_ms,
        });
        events.push("typed");
      }
    }
  }

  if (payload.clipboard?.text) {
    const text = String(payload.clipboard.text).slice(0, LIMITS.clipboardStored);
    if (!contentForModel(text) || isInfraNoise(text)) {
      if (state.activity.clipboard) state.activity.clipboard = null;
    } else if (text !== state.activity.clipboard?.text) {
      state.activity.clipboard = { text };
      appendEpisode({
        type: "pc_clipboard",
        text: text.slice(0, LIMITS.episodeText),
      });
      events.push("clipboard");
    }
  }

  if (payload.selection?.text) {
    const text = String(payload.selection.text).slice(0, LIMITS.clipboardStored);
    if (!contentForModel(text) || isInfraNoise(text)) {
      if (state.activity.selection) state.activity.selection = null;
    } else if (text !== state.activity.selection?.text) {
      state.activity.selection = {
        text,
        source: payload.selection.source || "primary",
      };
      appendEpisode({
        type: "pc_selection",
        text: text.slice(0, LIMITS.episodeSelectionLong),
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
        name: String(payload.a11y.name || "").slice(0, LIMITS.a11yName),
        role: String(payload.a11y.role || "").slice(0, LIMITS.a11yRole),
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
          value: next.value.slice(0, LIMITS.episodeText),
          selection: next.selection.slice(0, LIMITS.episodeSelection),
        });
        events.push("a11y");
      }
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
    const next = payload.recent_files.map(String).slice(0, LIMITS.recentFiles);
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
    const next = payload.open_files.map(String).slice(0, LIMITS.openFiles);
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
      threshold_ms: Number(payload.idle.threshold_ms ?? config.pcIdleMs),
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

  const material = events.some((e) => THINK_MATERIAL.has(e));
  if (material && !skip) {
    const reason = events.includes("typed")
      ? "typed"
      : events.includes("idle")
        ? "idle"
        : "focus";
    scheduleTurn(reason);
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

    const learned = applyLearn(decision.learn);
    if (learned.knowsNew || learned.knowsUpdated || learned.user) {
      console.log(
        `[companion:learn] new=${learned.knowsNew} updated=${learned.knowsUpdated} rejected=${learned.knowsRejected} user=${learned.user}`,
      );
    } else if (learned.knowsRejected) {
      console.log(`[companion:learn] rejected=${learned.knowsRejected} (junk/echo/infra)`);
    }

    if (!decision.silence && decision.speak) {
      state.lastSpeak = decision.speak;
      state.lastSpokeAt = Date.now();
      setCaption(decision.speak);
      if (decision.emotion) setEmotion(decision.emotion);
      else setEmotion("speak");
      appendEpisode({
        type: "spoke",
        text: decision.speak,
        emotion: decision.emotion,
      });
      state.awaitingUser = false;
    } else if (decision.emotion && CALM_EMOTIONS.has(decision.emotion)) {
      // Silence: balloon expires via captionUntil; only calm mood shifts.
      setEmotion(decision.emotion);
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
  }, config.drainIntervalMs);
  setTimeout(() => {
    if (!state.thinkBusy && !state.pendingTurn) scheduleTurn("boot");
  }, config.bootDelayMs);
  if (config.proactiveMs > 0) {
    proactiveTimer = setInterval(
      maybeProactive,
      Math.min(config.proactiveTickMs, config.proactiveMs),
    );
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
    orb_size: {
      width: config.orb.width,
      height: config.orb.height,
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
    knows: getWorldSnapshot().knows.slice(-8),
  };
}
