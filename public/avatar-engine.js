/**
 * Parametric orb face — classic jelly layout.
 * Model drives every channel. Host only morphs/renders numbers — no invented motion.
 */

const NS = "http://www.w3.org/2000/svg";

const KEYS = [
  "look_x",
  "look_y",
  "eye_l",
  "eye_r",
  "eye_curve_l",
  "eye_curve_r",
  "eye_heart_l",
  "eye_heart_r",
  "brow_l",
  "brow_r",
  "brow_tilt_l",
  "brow_tilt_r",
  "mouth_open",
  "mouth_smile",
  "mouth_wide",
  "mouth_smirk",
  "squash",
  "glow",
  "energy",
  "hue",
  "sat",
  "light",
  "blush",
  "tear",
  "zzz",
  "ask",
  "sweat",
];

/** Must match lib/avatar.mjs DEFAULT_FACE. */
const DEFAULT_FACE = {
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
};

const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

function el(name, attrs = {}) {
  const n = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

function clear(n) {
  while (n.firstChild) n.removeChild(n.firstChild);
}

function blobPath(cx, cy, rx, ry, t, energy, squash) {
  const n = 36;
  const sx = 1 - squash * 0.34;
  const sy = 1 + squash * 0.4;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    let r =
      1 +
      Math.sin(ang * 2 + t * 1.55) * 0.055 * energy +
      Math.sin(ang * 3 - t * 1.1) * 0.04 * energy +
      Math.sin(ang + t * 2.1) * 0.03 * energy;
    const bulgeAng = t * 0.85;
    r += Math.pow(Math.max(0, Math.cos(ang - bulgeAng)), 3) * 0.09 * energy;
    r +=
      Math.pow(Math.max(0, Math.cos(ang - bulgeAng + Math.PI)), 3) *
      0.06 *
      energy;
    pts.push([
      cx + Math.cos(ang) * rx * sx * r,
      cy + Math.sin(ang) * ry * sy * r,
    ]);
  }
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    d += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(2)} ${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(2)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(2)} ${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return `${d}Z`;
}

function heartPath(cx, cy, s) {
  const k = s / 9.5;
  const ox = cx - 12 * k;
  const oy = cy - 11.2 * k;
  const X = (x) => ox + x * k;
  const Y = (y) => oy + y * k;
  return [
    `M${X(12)} ${Y(21.35)}`,
    `L${X(10.55)} ${Y(20.03)}`,
    `C${X(5.4)} ${Y(15.36)}, ${X(2)} ${Y(12.28)}, ${X(2)} ${Y(8.5)}`,
    `C${X(2)} ${Y(5.42)}, ${X(4.42)} ${Y(3)}, ${X(7.5)} ${Y(3)}`,
    `C${X(9.24)} ${Y(3)}, ${X(10.91)} ${Y(3.81)}, ${X(12)} ${Y(5.09)}`,
    `C${X(13.09)} ${Y(3.81)}, ${X(14.76)} ${Y(3)}, ${X(16.5)} ${Y(3)}`,
    `C${X(19.58)} ${Y(3)}, ${X(22)} ${Y(5.42)}, ${X(22)} ${Y(8.5)}`,
    `C${X(22)} ${Y(12.28)}, ${X(18.6)} ${Y(15.36)}, ${X(13.45)} ${Y(20.03)}`,
    "Z",
  ].join(" ");
}

function drawFace(g, s, cx, cy, rx, ry, t = 0) {
  clear(g);
  const ink = "#1a1008";
  const blush = s.blush || 0;
  const faceH = Math.max(ry * 0.92, 48);
  const eyeY = cy - faceH * 0.18;
  const mouthY = cy + faceH * 0.34;
  const gap = Math.min(rx * 0.3, 28);
  const lookX = s.look_x * rx * 0.1;
  const lookY = clamp(s.look_y, -1, 0.55) * faceH * 0.05;

  if (blush > 0.04) {
    const by = cy + faceH * 0.08;
    for (const side of [-1, 1]) {
      g.appendChild(
        el("ellipse", {
          cx: cx + side * gap * 1.25 + lookX * 0.3,
          cy: by,
          rx: 13,
          ry: 7,
          fill: "#ff6b7a",
          opacity: blush * 0.4,
        }),
      );
    }
  }

  const zzz = s.zzz || 0;
  if (zzz > 0.08) {
    for (let i = 0; i < 4; i++) {
      const rise = (t * 16 + i * 14) % 42;
      const node = g.appendChild(
        el("text", {
          x: cx + 26 + i * 7 + Math.sin(t * 1.3 + i) * 2,
          y: cy - 14 - rise,
          fill: ink,
          opacity: Math.max(0.08, zzz * 0.7 - rise / 50),
          "font-size": 9 + i * 2.2,
          "font-family": "Syne, Outfit, sans-serif",
          "font-weight": 800,
          "font-style": "italic",
        }),
      );
      node.textContent = "z";
    }
  }

  const ask = s.ask || 0;
  if (ask > 0.08) {
    for (let i = 0; i < 2; i++) {
      const rise = (t * 12 + i * 18) % 34;
      const node = g.appendChild(
        el("text", {
          x: cx + 30 + i * 10,
          y: cy - 18 - rise,
          fill: ink,
          opacity: Math.max(0.1, ask * 0.75 - rise / 42),
          "font-size": 14 + i * 3,
          "font-family": "Syne, Outfit, sans-serif",
          "font-weight": 800,
        }),
      );
      node.textContent = "?";
    }
  }

  function drawBrow(side, ex, ey, lift, tilt) {
    if (lift < 0.04 && Math.abs(tilt) < 0.08) return;
    const half = 11;
    const outer = side === "L" ? ex - half : ex + half;
    const inner = side === "L" ? ex + half : ex - half;
    const liftPx = lift * 8;
    const yO = ey - 13 - liftPx + tilt * (side === "L" ? 4 : -4);
    const yI = ey - 13 - liftPx - tilt * (side === "L" ? 4 : -4);
    const ctrlY = (yO + yI) / 2 - 2 - liftPx * 0.3;
    g.appendChild(
      el("path", {
        d: `M${outer} ${yO} Q${ex} ${ctrlY} ${inner} ${yI}`,
        fill: "none",
        stroke: ink,
        "stroke-width": 2.6,
        "stroke-linecap": "round",
      }),
    );
  }

  function drawEye(side, open, curve, heart) {
    const ex = cx + (side === "L" ? -gap : gap) + lookX;
    const ey = eyeY + lookY;
    const lift = side === "L" ? s.brow_l : s.brow_r;
    const tilt = side === "L" ? s.brow_tilt_l : s.brow_tilt_r;
    drawBrow(side, ex, ey, lift, tilt);

    if (heart > 0.35) {
      const pulse = 1 + heart * 0.15;
      g.appendChild(
        el("path", {
          d: heartPath(ex, ey + 1, 10.5 * pulse * (0.7 + heart * 0.3)),
          fill: ink,
          opacity: 0.55 + heart * 0.45,
        }),
      );
      if (heart > 0.85) return;
    }

    if (curve > 0.35 || (open < 0.35 && curve >= 0)) {
      const arch = 8.5 + curve * 2;
      g.appendChild(
        el("path", {
          d: `M${ex - 11} ${ey + 2} Q${ex} ${ey - arch} ${ex + 11} ${ey + 2}`,
          fill: "none",
          stroke: ink,
          "stroke-width": 3.9,
          "stroke-linecap": "round",
        }),
      );
      return;
    }

    if (curve < -0.25 || open < 0.28) {
      const bend = curve < -0.5 ? 3.2 : curve < 0 ? 1.2 : -1.2;
      g.appendChild(
        el("path", {
          d: `M${ex - 11} ${ey} Q${ex} ${ey + bend} ${ex + 11} ${ey}`,
          fill: "none",
          stroke: ink,
          "stroke-width": curve < -0.5 ? 4 : 3.5,
          "stroke-linecap": "round",
        }),
      );
      return;
    }

    const r = 12.8 - Math.abs(curve) * 1.2;
    if (open > 0.82) {
      g.appendChild(el("circle", { cx: ex, cy: ey, r, fill: ink }));
      return;
    }
    g.appendChild(
      el("ellipse", {
        cx: ex,
        cy: ey,
        rx: r,
        ry: Math.max(2.4, r * open),
        fill: ink,
      }),
    );
  }

  drawEye("L", s.eye_l, s.eye_curve_l, s.eye_heart_l);
  drawEye("R", s.eye_r, s.eye_curve_r, s.eye_heart_r);

  const tear = s.tear || 0;
  if (tear > 0.08) {
    const tx = cx + gap * 0.55 + lookX;
    const ty = eyeY + lookY + 11 + tear * 4;
    g.appendChild(
      el("path", {
        d: `M${tx} ${ty - 4} Q${tx - 3.2} ${ty + 1} ${tx} ${ty + 5.5} Q${tx + 3.2} ${ty + 1} ${tx} ${ty - 4}Z`,
        fill: "#7ec8ff",
        opacity: 0.4 + tear * 0.45,
      }),
    );
  }

  const sweat = s.sweat || 0;
  if (sweat > 0.08) {
    const sx = cx + gap + 20 + lookX * 0.2;
    const sy = eyeY + lookY - 22;
    g.appendChild(
      el("path", {
        d: `M${sx} ${sy} Q${sx - 3.2} ${sy + 5.5} ${sx} ${sy + 10} Q${sx + 3.2} ${sy + 5.5} ${sx} ${sy}Z`,
        fill: "#c5ebff",
        stroke: "#7eb8d8",
        "stroke-width": 0.8,
        opacity: 0.55 + sweat * 0.35,
      }),
    );
  }

  const mx = cx + lookX * 0.35 + (s.mouth_smirk || 0) * 4;
  const my = mouthY;
  const smile = s.mouth_smile;
  const open = s.mouth_open;
  const wide = s.mouth_wide;

  if (open > 0.55 && smile > 0.45) {
    const w = 12 + open * 6 + wide * 4;
    const h = Math.min(7 + open * 5, 13);
    g.appendChild(
      el("path", {
        d: `M${mx - w} ${my} Q${mx} ${my - 5} ${mx + w} ${my} Q${mx + w} ${my + h} ${mx} ${my + h + 1} Q${mx - w} ${my + h} ${mx - w} ${my} Z`,
        fill: ink,
      }),
    );
    return;
  }

  if (open > 0.45 && wide > 0.55) {
    g.appendChild(
      el("circle", {
        cx: mx,
        cy: my + 1,
        r: 5.5 + wide * 8,
        fill: ink,
      }),
    );
    return;
  }

  if (open > 0.2) {
    const w = 6 + open * 10 + wide * 4;
    const h = Math.min(2.5 + open * 9, 11);
    g.appendChild(el("ellipse", { cx: mx, cy: my, rx: w, ry: h, fill: ink }));
    return;
  }

  const half = 9 + Math.abs(smile) * 6 + wide * 4;
  const bend = smile * 10;
  if (Math.abs(smile) < 0.12) {
    g.appendChild(
      el("path", {
        d: `M${mx - half} ${my} L${mx + half} ${my}`,
        fill: "none",
        stroke: ink,
        "stroke-width": 3.4,
        "stroke-linecap": "round",
      }),
    );
    return;
  }
  g.appendChild(
    el("path", {
      d: `M${mx - half} ${my - bend * 0.08} Q${mx} ${my + bend} ${mx + half} ${my - bend * 0.08}`,
      fill: "none",
      stroke: ink,
      "stroke-width": 3.7,
      "stroke-linecap": "round",
    }),
  );
}

export function createAvatarController({ bloom, body, face, orbRoot, j0, j1, j2 }) {
  const pose = { ...DEFAULT_FACE };
  const target = { ...DEFAULT_FACE };

  function setGrad(hue, sat, light, glow) {
    const L = light + glow * 16;
    j0.setAttribute("stop-color", hsl(hue, sat, Math.min(92, L + 20)));
    j1.setAttribute("stop-color", hsl(hue, sat, clamp(L, 20, 85)));
    j2.setAttribute(
      "stop-color",
      hsl(hue, Math.max(40, sat - 8), Math.max(28, L - 22)),
    );
    bloom.setAttribute(
      "fill",
      hsl(hue, Math.min(100, sat + 6), clamp(L + 8, 30, 95)),
    );
  }

  function setFace(next) {
    if (!next || typeof next !== "object") return;
    for (const k of KEYS) {
      if (next[k] == null || !Number.isFinite(Number(next[k]))) continue;
      target[k] = Number(next[k]);
    }
  }

  let lastTickMs = 0;
  function tick(now) {
    const dtSec = lastTickMs
      ? Math.min(0.05, Math.max(0.001, (now - lastTickMs) / 1000))
      : 1 / 60;
    lastTickMs = now;
    const ease = 1 - Math.exp(-0.42 * dtSec * 60);
    for (const k of KEYS) pose[k] = lerp(pose[k] ?? 0, target[k] ?? 0, ease);

    // Body phase from model energy only — no wall-clock life inventada.
    const phase = (pose.energy ?? 0) * 2.4;
    orbRoot.setAttribute("transform", "translate(0 0)");
    const cx = 160;
    const cy = 112;
    const baseR = 62;
    const energy = Math.min(1.05, (pose.energy ?? 0.8) * 0.8);
    setGrad(pose.hue, pose.sat, pose.light, pose.glow);
    bloom.setAttribute(
      "d",
      blobPath(cx, cy, baseR * 1.18, baseR * 1.1, phase * 0.9, energy * 0.7, pose.squash),
    );
    body.setAttribute(
      "d",
      blobPath(cx, cy, baseR, baseR * 0.94, phase, energy, pose.squash),
    );
    const rx = baseR * (1 - pose.squash * 0.34);
    const ry = baseR * 0.94 * (1 + pose.squash * 0.4);
    // t for zzz/ask drift = render those channels; amounts still from model.
    const accentT = (pose.zzz || 0) + (pose.ask || 0) > 0 ? now / 1000 : 0;
    drawFace(face, pose, cx, cy, rx, ry, accentT);
  }

  setFace(DEFAULT_FACE);
  return { setFace, tick, getFace: () => ({ ...pose }) };
}
