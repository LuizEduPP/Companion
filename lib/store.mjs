import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { hostname, platform, arch, userInfo, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config } from "./config.mjs";
import { isInfraNoise, LIMITS } from "./sense/util.mjs";

mkdirSync(config.dataDir, { recursive: true });

const EPISODE_CAP = 400;
/** High-chatter sensor episodes — keep fewer. */
const NOISY_EPISODE_TYPES = new Set([
  "pc_typed",
  "pc_a11y",
  "pc_focus",
  "pc_clipboard",
  "pc_idle",
  "pc_active",
]);
const DURABLE_EPISODE_TYPES = new Set([
  "spoke",
  "learned",
  "user_profile_updated",
  "pc_page",
  "pc_file",
  "pc_selection",
  "pc_windows",
  "pc_recent",
  "pc_open_files",
  "nudge",
]);
const ALLOWED_EPISODE_TYPES = new Set([
  ...DURABLE_EPISODE_TYPES,
  ...NOISY_EPISODE_TYPES,
]);

function resolvedLocale() {
  const fromEnv = String(process.env.COMPANION_LOCALE || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "";
  } catch {
    return "";
  }
}

/** Compiled memory: user + knows[] + episodes. */
const EMPTY_STORE = {
  user: null,
  knows: [],
  episodes: [],
};

const EMPTY_USER = {
  name: "",
  locale: resolvedLocale(),
  timezone: "",
  notes: "",
  gaps: [],
  host: {},
  updated_at: null,
  created_at: null,
};

const SECTION_KEYS = Object.keys(EMPTY_STORE);

function writeStoreFile(store) {
  const body = `${JSON.stringify(store, null, 2)}\n`;
  const tmp = join(config.dataDir, `.memory.${process.pid}.tmp`);
  writeFileSync(tmp, body);
  renameSync(tmp, config.storePath);
}

function normalizeStore(raw) {
  const out = { ...EMPTY_STORE };
  for (const key of SECTION_KEYS) {
    const def = EMPTY_STORE[key];
    const val = raw?.[key];
    if (Array.isArray(def)) {
      out[key] = Array.isArray(val) ? val : [];
    } else if (def === null) {
      out[key] = val && typeof val === "object" && !Array.isArray(val) ? val : null;
    } else {
      out[key] = val ?? def;
    }
  }
  return hygieneStore(out);
}

/** Drop junk / merge near-duplicate knows; keep slim user. */
function hygieneStore(store) {
  const lines = [];
  for (const k of store.knows || []) {
    const text = typeof k === "string" ? k : k?.text;
    if (text) lines.push(String(text).trim());
  }
  if (store.user && typeof store.user === "object") {
    store.user = {
      ...EMPTY_USER,
      name: store.user.name || "",
      locale: store.user.locale || resolvedLocale(),
      timezone: store.user.timezone || "",
      notes: store.user.notes || "",
      gaps: Array.isArray(store.user.gaps) ? store.user.gaps : [],
      host: store.user.host || {},
      updated_at: store.user.updated_at || null,
      created_at: store.user.created_at || null,
    };
  }

  const kept = [];
  for (const text of lines) {
    const clean = String(text || "").trim();
    if (!clean || isEchoFact(clean, store.user) || isJunkFact(clean) || isInfraNoise(clean)) {
      continue;
    }
    const twin = kept.findIndex((k) => factsSimilar(k.text, clean));
    if (twin >= 0) {
      const prev = kept[twin];
      if (clean.length >= String(prev.text || "").length) {
        kept[twin] = {
          ...prev,
          text: clean,
          updated_at: new Date().toISOString(),
        };
      }
      continue;
    }
    kept.push({
      id: slug(clean.slice(0, 48)),
      text: clean,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });
  }
  store.knows = kept.slice(-48);
  store.episodes = hygieneEpisodes(store.episodes);
  return store;
}

function episodeBlob(e) {
  return String(e?.text ?? e?.value ?? e?.title ?? "").trim();
}

function hygieneEpisodes(episodes) {
  const out = [];
  for (const raw of episodes || []) {
    if (!raw || typeof raw.type !== "string") continue;
    if (!ALLOWED_EPISODE_TYPES.has(raw.type)) continue;
    const e = { ...raw };

    if (e.type === "pc_typed" || e.type === "pc_a11y" || e.type === "pc_clipboard") {
      const blob = episodeBlob(e);
      if (isInfraNoise(blob)) continue;
      if (typeof e.text === "string") e.text = e.text.slice(0, LIMITS.episodeText);
      if (typeof e.value === "string") e.value = e.value.slice(0, LIMITS.episodeText);
      if (typeof e.selection === "string") {
        e.selection = e.selection.slice(0, LIMITS.episodeSelection);
      }
    }

    const prev = out[out.length - 1];
    if (prev && prev.type === e.type) {
      if (
        e.type === "pc_focus" &&
        prev.app === e.app &&
        prev.title === e.title
      ) {
        out[out.length - 1] = e; // refresh timestamp only
        continue;
      }
      if (
        (e.type === "pc_typed" || e.type === "pc_a11y" || e.type === "pc_clipboard") &&
        episodeBlob(prev) === episodeBlob(e)
      ) {
        out[out.length - 1] = e;
        continue;
      }
      if (e.type === "pc_idle" || e.type === "pc_active") {
        out[out.length - 1] = e;
        continue;
      }
    }
    out.push(e);
  }

  // Prefer durable signal; keep a short tail of noisy sensor chatter.
  const durable = [];
  const noisy = [];
  for (const e of out) {
    if (DURABLE_EPISODE_TYPES.has(e.type)) durable.push(e);
    else if (NOISY_EPISODE_TYPES.has(e.type)) noisy.push(e);
    else durable.push(e);
  }
  return [...durable.slice(-280), ...noisy.slice(-120)].sort((a, b) =>
    String(a.at || "").localeCompare(String(b.at || "")),
  ).slice(-EPISODE_CAP);
}

export function appendEpisode(event) {
  if (!event || typeof event.type !== "string") {
    throw new Error("episode.type is required");
  }
  if (!ALLOWED_EPISODE_TYPES.has(event.type)) return null;
  let row = { ...event, at: event.at ?? new Date().toISOString() };

  // Never persist companion/infra dumps as sensor episodes.
  if (
    row.type === "pc_typed" ||
    row.type === "pc_a11y" ||
    row.type === "pc_clipboard"
  ) {
    const blob = episodeBlob(row);
    if (isInfraNoise(blob)) return null;
    if (typeof row.text === "string") row.text = row.text.slice(0, LIMITS.episodeText);
    if (typeof row.value === "string") row.value = row.value.slice(0, LIMITS.episodeText);
  }

  updateStore((store) => {
    const prev = store.episodes[store.episodes.length - 1];
    if (
      prev &&
      prev.type === row.type &&
      row.type === "pc_focus" &&
      prev.app === row.app &&
      prev.title === row.title
    ) {
      store.episodes[store.episodes.length - 1] = row;
      return store;
    }
    if (
      prev &&
      prev.type === row.type &&
      (row.type === "pc_typed" || row.type === "pc_a11y") &&
      episodeBlob(prev) === episodeBlob(row)
    ) {
      store.episodes[store.episodes.length - 1] = row;
      return store;
    }
    store.episodes = [...store.episodes, row].slice(-EPISODE_CAP);
    return store;
  });
  return row;
}

export function loadStore() {
  if (!existsSync(config.storePath)) {
    const fresh = structuredClone(EMPTY_STORE);
    writeStoreFile(fresh);
    return fresh;
  }
  const raw = readFileSync(config.storePath, "utf8").trim();
  if (!raw) {
    const fresh = structuredClone(EMPTY_STORE);
    writeStoreFile(fresh);
    return fresh;
  }
  try {
    const parsed = JSON.parse(raw);
    const normalized = normalizeStore(parsed);
    // Persist hygiene (junk/dedupe) so disk matches runtime.
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      writeStoreFile(normalized);
    }
    return normalized;
  } catch (err) {
    console.warn(`[store] corrupt ${config.storePath}: ${err.message}; resetting`);
    const fresh = structuredClone(EMPTY_STORE);
    writeStoreFile(fresh);
    return fresh;
  }
}

export function saveStore(store) {
  writeStoreFile(normalizeStore(store));
  return store;
}

export function updateStore(mutator) {
  const store = loadStore();
  const next = mutator(store) ?? store;
  return saveStore(next);
}

export function recentEpisodes(limit = 24) {
  const episodes = loadStore().episodes;
  // Prefer durable signal for the model context.
  const durable = episodes.filter((e) => DURABLE_EPISODE_TYPES.has(e?.type));
  const rest = episodes.filter((e) => !DURABLE_EPISODE_TYPES.has(e?.type));
  const mixed = [...durable.slice(-Math.ceil(limit * 0.7)), ...rest.slice(-Math.floor(limit * 0.3))];
  mixed.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
  if (mixed.length <= limit) return mixed;
  return mixed.slice(-limit);
}

/** Cheap host/session signals — no screen capture. */
export function getHostContext() {
  let username = "";
  try {
    username = userInfo().username || "";
  } catch {
    username = process.env.USER || process.env.USERNAME || "";
  }
  let timezone = "";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    timezone = "";
  }
  const now = new Date();
  const locale = resolvedLocale();
  const local_clock = now.toLocaleString(locale || undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const local_date = now.toLocaleDateString(locale || undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const weekday = now.toLocaleDateString(locale || undefined, {
    weekday: "long",
  });
  return {
    username,
    hostname: hostname() || "",
    platform: platform(),
    arch: arch(),
    home: homedir() || "",
    timezone,
    local_iso: now.toISOString(),
    local_clock,
    local_date,
    weekday,
    /** Human label for the model: weekday + date + clock. */
    now: [weekday, local_date, local_clock].filter(Boolean).join(" · "),
  };
}

function normalizeUser(prev, host) {
  if (!prev || typeof prev !== "object") {
    return {
      ...EMPTY_USER,
      name: String(process.env.COMPANION_USER_NAME || "").trim(),
      timezone: host.timezone,
      host,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }
  return {
    ...EMPTY_USER,
    ...prev,
    host: { ...host, ...(prev.host || {}), ...host },
    timezone: prev.timezone || host.timezone,
  };
}

export function getUserProfile() {
  const host = getHostContext();
  const store = loadStore();
  const prev = store.user;
  const merged = normalizeUser(prev, host);
  const needsWrite =
    !prev ||
    !prev.host?.username ||
    prev.host.username !== host.username ||
    !store.user;

  if (needsWrite) {
    merged.updated_at = new Date().toISOString();
    updateStore((s) => {
      s.user = merged;
      return s;
    });
  }
  return merged;
}

export function patchUserProfile(patch = {}) {
  const cur = getUserProfile();
  const next = { ...EMPTY_USER, ...cur };
  const changed = new Set();

  if (typeof patch.name === "string" && patch.name.trim()) {
    const name = patch.name.trim();
    if (name !== cur.name) {
      next.name = name;
      changed.add("name");
    }
  }
  if (typeof patch.notes === "string" && patch.notes.trim()) {
    const note = patch.notes.trim();
    if (!String(cur.notes || "").includes(note)) {
      next.notes = [cur.notes, note].filter(Boolean).join(" · ").slice(0, LIMITS.notes);
      changed.add("notes");
    }
  }
  if (typeof patch.locale === "string" && patch.locale.trim()) {
    const locale = patch.locale.trim();
    if (locale !== cur.locale) {
      next.locale = locale;
      changed.add("locale");
    }
  }
  if (typeof patch.timezone === "string" && patch.timezone.trim()) {
    const tz = patch.timezone.trim();
    if (tz !== cur.timezone) {
      next.timezone = tz;
      changed.add("timezone");
    }
  }
  if (Array.isArray(patch.gaps)) {
    const byId = new Map((next.gaps || []).map((g) => [g.id, g]));
    let gapsChanged = false;
    for (const g of patch.gaps) {
      if (!g?.id && !g?.about) continue;
      const id = String(g.id || g.about)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40);
      const row = {
        id,
        about: String(g.about ?? id),
        question: String(g.question ?? "").trim() || null,
        priority: Number(g.priority ?? 50),
        filled: Boolean(g.filled),
      };
      const prev = byId.get(id);
      if (
        !prev ||
        prev.about !== row.about ||
        prev.question !== row.question ||
        prev.priority !== row.priority ||
        prev.filled !== row.filled
      ) {
        gapsChanged = true;
      }
      byId.set(id, row);
    }
    if (gapsChanged) {
      next.gaps = [...byId.values()]
        .filter((g) => !g.filled)
        .sort((a, b) => b.priority - a.priority)
        .slice(0, 12);
      changed.add("gaps");
    }
  }

  if (!changed.size) return cur;

  next.updated_at = new Date().toISOString();
  if (!next.created_at) next.created_at = next.updated_at;
  updateStore((s) => {
    s.user = next;
    return s;
  });
  appendEpisode({ type: "user_profile_updated", keys: [...changed] });
  return next;
}

export function listProfileGaps(profile = getUserProfile()) {
  // Only gaps the model (or caller) wrote into profile.gaps — no fixed catalog.
  const gaps = (profile.gaps || [])
    .filter((g) => g && !g.filled && (g.about || g.question || g.id))
    .map((g) => ({
      id: String(g.id || g.about || "gap")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40),
      about: String(g.about ?? g.id ?? ""),
      priority: Number(g.priority ?? 50),
      question: String(g.question ?? "").trim() || null,
    }))
    .filter((g) => g.about || g.question);

  gaps.sort((a, b) => b.priority - a.priority);
  const seen = new Set();
  return gaps.filter((g) => {
    if (seen.has(g.id)) return false;
    seen.add(g.id);
    return true;
  });
}

export function topGap(profile = getUserProfile()) {
  return listProfileGaps(profile)[0] || null;
}

function slug(name) {
  return (
    String(name ?? "x")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || randomUUID().slice(0, 8)
  );
}

export function getWorldSnapshot() {
  const store = loadStore();
  const user = getUserProfile();
  return {
    user: {
      name: user.name || "",
      locale: user.locale || "",
      timezone: user.timezone || "",
      notes: String(user.notes || "").slice(0, 400),
    },
    gaps: listProfileGaps(user),
    knows: (store.knows || []).slice(-40).map((k) =>
      typeof k === "string" ? k : String(k?.text || ""),
    ),
  };
}

/** Append/update one durable note in the compiled knows list. */
export function upsertKnow({ id, text } = {}) {
  const clean = String(text ?? "").trim();
  if (!clean) return null;
  if (isJunkFact(clean) || isEchoFact(clean, getUserProfile()) || isInfraNoise(clean)) {
    return null;
  }
  let row;
  let isNew = false;
  let textChanged = false;
  updateStore((store) => {
    const knows = store.knows || (store.knows = []);
    const key = id || slug(clean.slice(0, 48));
    const norm = clean.toLowerCase();
    let idx = knows.findIndex(
      (f) =>
        f.id === key ||
        f.text === clean ||
        String(f.text || "").trim().toLowerCase() === norm ||
        factsSimilar(f.text, clean),
    );
    row = {
      id: key,
      text: clean,
      updated_at: new Date().toISOString(),
    };
    if (idx >= 0) {
      row = {
        ...knows[idx],
        ...row,
        id: knows[idx].id,
        text:
          clean.length >= String(knows[idx].text || "").length
            ? clean
            : knows[idx].text,
        created_at: knows[idx].created_at || row.updated_at,
      };
      textChanged = String(knows[idx].text || "") !== row.text;
      knows[idx] = row;
    } else {
      isNew = true;
      knows.push({ ...row, created_at: row.updated_at });
      store.knows = knows.slice(-48);
    }
    return store;
  });
  if (isNew || textChanged) {
    appendEpisode({ type: "learned", text: row.text });
    return { ...row, _status: isNew ? "new" : "updated" };
  }
  return { ...row, _status: "unchanged" };
}

export function applyLearn(learn) {
  const summary = { knowsNew: 0, knowsUpdated: 0, knowsRejected: 0, user: false };
  if (!learn || typeof learn !== "object") return summary;

  if (learn.user && typeof learn.user === "object") {
    const before = getUserProfile();
    patchUserProfile({
      name: learn.user.name,
      notes: learn.user.notes,
      locale: learn.user.locale,
      timezone: learn.user.timezone,
      gaps: learn.user.gaps,
    });
    const after = getUserProfile();
    summary.user =
      before.name !== after.name ||
      before.notes !== after.notes ||
      before.locale !== after.locale ||
      before.timezone !== after.timezone;
  }

  const list = normalizeKnowsInput(learn.knows);
  for (const text of list) {
    const row = upsertKnow({ text });
    if (!row) summary.knowsRejected += 1;
    else if (row._status === "new") summary.knowsNew += 1;
    else if (row._status === "updated") summary.knowsUpdated += 1;
  }
  return summary;
}

function normalizeKnowsInput(raw) {
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

function factTokens(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .filter(
      (w) =>
        ![
          "user",
          "usuario",
          "that",
          "this",
          "with",
          "from",
          "have",
          "been",
          "about",
          "their",
          "there",
          "currently",
          "regarding",
          "actively",
          "focused",
          "recent",
          "activity",
          "involved",
          "system",
          "internal",
        ].includes(w),
    );
}

function factsSimilar(a, b) {
  const ta = new Set(factTokens(a));
  const tb = new Set(factTokens(b));
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  if (!union) return false;
  // Same topic (e.g. repeated Mercado Pago paraphrases).
  if (inter >= 3 && inter / union >= 0.45) return true;
  if (inter >= 2 && inter / Math.min(ta.size, tb.size) >= 0.7) return true;
  return false;
}

/** Skip notes that only restate profile/host/clipboard already known. */
function isEchoFact(text, user) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return true;
  if (/clipboard content|last recorded clipboard/.test(t)) return true;
  if (/host machine|hostname is|platform is linux/.test(t)) return true;
  if (user?.name) {
    const n = String(user.name).toLowerCase();
    if (t.includes(n) && /user name|nome (do )?usu[aá]rio|name is/.test(t)) {
      return true;
    }
  }
  if (user?.locale) {
    const loc = String(user.locale).toLowerCase();
    if (t.includes(loc) && /locale/.test(t)) return true;
  }
  if (/^user (name|locale) is /.test(t)) return true;
  return false;
}

/** Transient / meta / filler — not durable memory. */
function isJunkFact(text) {
  const t = String(text || "").trim().toLowerCase();
  if (t.length < 12) return true;
  if (
    /waiting for the next step|tela quieta|tudo parado|focused on productivity|actively managing (system|an internal)|actively interacting with a system|recent activity involved|projeto [xy]\b|something new about|likes dark ui/i.test(
      t,
    )
  ) {
    return true;
  }
  // Snapshot of “what they're doing right now” — not a durable belief.
  if (
    /\b(foco atual|atividade recente|est[aá] (ativamente |imerso |trabalhando|implementando|executando)|conforme (indicado|evidenciado)|caminhos? de (arquivo|diret[oó]rio)|clipboard|no momento|right now|currently (working|focused|implementing))\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /companion named ['"]?manage(ing)? (its|their) processes|brain, sense, orb|restart and configure components of their|system component referred|json parsing failure|execution of these commands/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/system preferences related to notifications and work style/i.test(t)) {
    return true;
  }
  // Meta about this companion process / its own stack / editing itself as topic.
  if (
    /\b(companion)\b/.test(t) &&
    /(terminal|process|brain|sense|orb|component|hot.?reload|implementa|projeto ['"]?companion|sistema ['"]?companion|l[oó]gica do (projeto|sistema))/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}
