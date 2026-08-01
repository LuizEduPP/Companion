export const DEFAULT_FACE = Object.freeze({
  look_x: 0,
  look_y: 0.02,
  eye_l: 1,
  eye_r: 1,
  eye_curve_l: 0,
  eye_curve_r: 0,
  eye_heart_l: 0,
  eye_heart_r: 0,
  brow_l: 0,
  brow_r: 0,
  brow_tilt_l: 0,
  brow_tilt_r: 0,
  mouth_open: 0,
  mouth_smile: 0.35,
  mouth_wide: 0,
  mouth_smirk: 0,
  squash: 0.04,
  glow: 0.78,
  energy: 0.8,
  hue: 34,
  sat: 86,
  light: 52,
  blush: 0,
  tear: 0,
  zzz: 0,
  ask: 0,
  sweat: 0,
});

export const FACE_KEYS = Object.freeze(Object.keys(DEFAULT_FACE));

const RANGES = Object.freeze({
  look_x: [-1, 1],
  look_y: [-1, 1],
  eye_l: [0, 1],
  eye_r: [0, 1],
  eye_curve_l: [-1, 1],
  eye_curve_r: [-1, 1],
  eye_heart_l: [0, 1],
  eye_heart_r: [0, 1],
  brow_l: [0, 1],
  brow_r: [0, 1],
  brow_tilt_l: [-1, 1],
  brow_tilt_r: [-1, 1],
  mouth_open: [0, 1],
  mouth_smile: [-1, 1],
  mouth_wide: [0, 1],
  mouth_smirk: [0, 1],
  squash: [-1, 1],
  glow: [0, 1],
  energy: [0, 1.2],
  hue: [0, 360],
  sat: [0, 100],
  light: [0, 100],
  blush: [0, 1],
  tear: [0, 1],
  zzz: [0, 1],
  ask: [0, 1],
  sweat: [0, 1],
});

function num(raw, lo, hi, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function normalizeFace(raw, prior = null) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.svg === "string" || typeof raw.markup === "string") return null;
  const base = prior && typeof prior === "object" ? { ...prior } : { ...DEFAULT_FACE };
  const out = { ...base };
  let any = false;
  for (const key of FACE_KEYS) {
    if (!(key in raw)) continue;
    const [lo, hi] = RANGES[key];
    out[key] = num(raw[key], lo, hi, base[key]);
    any = true;
  }
  return any ? out : null;
}
