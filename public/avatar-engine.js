/** Canonical port of keeper/cyd/design/avatar-preview.html
 *  Emotions: idle,listening,thinking,speak,focused,happy,laugh,excited,wink,smug,
 *            love,shy,curious,sad,tired,sleepy,annoyed,angry,disgust,confused,scared,surprised
 *  Keep loops + drawFace signatures (♥ zzzz tear sweat ?) in sync with that file.
 */
const NS = "http://www.w3.org/2000/svg";
const KEYS = [
  "look_x", "look_y", "eye_l", "eye_r", "brow_l", "brow_r",
  "mouth_open", "mouth_smile", "mouth_wide", "squash", "glow", "hue",
];

const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const el = (name, attrs = {}) => {
      const n = document.createElementNS(NS, name);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      return n;
};
const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };

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
        r += Math.pow(Math.max(0, Math.cos(ang - bulgeAng + Math.PI)), 3) * 0.06 * energy;
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
      return d + "Z";
}

/**
     * Face contract:
     *   eyes:  open | crescent | soft | line | heart
     *   mouth: smile | frown | flat | O | speak | laugh | smirk | wavy
     *   brows: none | raise | sad | angry | quirk
     * Solid black eyes by default (no sclera).
     */
const EMOTIONS = {
      idle: {
        label: "idle",
        hue: 34, glow: 0.78, squash: 0.04, energy: 0.8,
        look_x: 0, look_y: 0.02, eye_l: 1, eye_r: 1, brow_l: 0, brow_r: 0,
        mouth_open: 0, mouth_smile: 0.35, mouth_wide: 0,
        eyes: "open", mouth: "smile", brows: "none", blush: 0,
        loop(t, p) {
          p.look_x = Math.sin(t * 0.32) * 0.28;
          p.look_y = 0.02 + Math.sin(t * 0.48) * 0.05;
          p.squash = 0.04 + Math.sin(t * 1.25) * 0.09;
          if (Math.sin(t * 0.38) > 0.93) { p.eye_l = 0.12; p.eye_r = 0.12; }

        },
      },
      listening: {
        label: "listening",
        hue: 195, glow: 0.82, squash: 0.04, energy: 0.78,
        look_x: 0, look_y: 0.02, eye_l: 1, eye_r: 1, brow_l: 0.35, brow_r: 0.35,
        mouth_open: 0, mouth_smile: 0.28, mouth_wide: 0,
        eyes: "soft", mouth: "smile", brows: "raise", blush: 0,
        loop(t, p) {
          // calm attentive breath — not worried/peaky
          const breath = (Math.sin(t * 1.6) + 1) / 2;
          p.glow = 0.72 + breath * 0.16;
          p.squash = 0.02 + breath * 0.1;
          p.energy = 0.7 + breath * 0.18;
          p.hue = 190 + breath * 10;
          p.look_x = Math.sin(t * 0.55) * 0.12;
          p.look_y = 0.02 + Math.sin(t * 0.7) * 0.04;
          p.mouth_smile = 0.22 + breath * 0.1;
          if (Math.sin(t * 0.4) > 0.93) { p.eye_l = 0.12; p.eye_r = 0.12; }
        },
      },
      thinking: {
        label: "thinking",
        hue: 262, glow: 0.55, squash: 0.22, energy: 0.75,
        look_x: -0.55, look_y: -0.28, eye_l: 1, eye_r: 1, brow_l: 0.15, brow_r: 0.55,
        mouth_open: 0, mouth_smile: 0, mouth_wide: 0,
        eyes: "open", mouth: "flat", brows: "quirk", blush: 0,
        loop(t, p) {
          const wander = Math.sin(t * 0.85);
          const lift = Math.sin(t * 0.55);
          const idea = Math.pow(Math.max(0, Math.sin(t * 1.15)), 8);
          p.look_x = -0.35 + wander * 0.42;
          p.look_y = -0.32 + lift * 0.18 + idea * 0.12;
          p.squash = 0.12 + Math.sin(t * 1.35) * 0.16 + idea * 0.18;
          p.energy = 0.55 + Math.abs(wander) * 0.25 + idea * 0.35;
          p.glow = 0.42 + Math.abs(lift) * 0.14 + idea * 0.28;
          p.hue = 255 + wander * 14 + idea * 20;
          // swap quirk tilt feel via brow style pulse
          p.brows = idea > 0.35 ? "raise" : "quirk";
          if (Math.sin(t * 0.42) > 0.9) { p.eye_l = 0.15; p.eye_r = 0.15; }

        },
      },
      speak: {
        label: "speak",
        hue: 32, glow: 0.88, squash: -0.04, energy: 0.92,
        look_x: 0, look_y: 0, eye_l: 1, eye_r: 1, brow_l: 0.1, brow_r: 0.1,
        mouth_open: 0.45, mouth_smile: 0.2, mouth_wide: 0.1,
        eyes: "open", mouth: "speak", brows: "none", blush: 0,
        loop(t, p) {
          // uneven talk rhythm — not a metronome
          const a = Math.abs(Math.sin(t * 7.2));
          const b = Math.abs(Math.sin(t * 11.3 + 0.6));
          const talk = Math.max(a * 0.75, b * 0.55);
          p.mouth_open = 0.15 + talk * 0.7;
          p.mouth_wide = 0.04 + talk * 0.16;
          p.squash = -0.03 + Math.sin(t * 3.2) * 0.05 + talk * 0.04;
          p.look_y = Math.sin(t * 1.4) * 0.03;

        },
      },
      focused: {
        label: "focused",
        hue: 205, glow: 0.58, squash: 0.14, energy: 0.78,
        look_x: 0, look_y: -0.1, eye_l: 1, eye_r: 1, brow_l: -0.3, brow_r: -0.3,
        mouth_open: 0, mouth_smile: 0.05, mouth_wide: 0,
        eyes: "soft", mouth: "flat", brows: "angry", blush: 0,
        loop(t, p) {
          // locked stare with tiny scan + concentration pulse
          const lock = (Math.sin(t * 2.2) + 1) / 2;
          const scan = Math.sin(t * 3.6);
          p.look_x = scan * 0.12;
          p.look_y = -0.14 + Math.sin(t * 1.8) * 0.05;
          p.squash = 0.08 + lock * 0.16 + Math.sin(t * 4.5) * 0.04;
          p.glow = 0.45 + lock * 0.22;
          p.energy = 0.65 + lock * 0.28;
          p.hue = 200 + lock * 14;
          if (Math.sin(t * 0.9) > 0.96) { p.eye_l = 0.18; p.eye_r = 0.18; }

        },
      },

      happy: {
        label: "happy",
        hue: 42, glow: 1, squash: -0.22, energy: 0.88,
        look_x: 0, look_y: 0, eye_l: 0.2, eye_r: 0.2, brow_l: 0.2, brow_r: 0.2,
        mouth_open: 0, mouth_smile: 1, mouth_wide: 0,
        eyes: "crescent", mouth: "smile", brows: "none", blush: 0.2,
        loop(t, p) {
          const bounce = 0.5 + 0.5 * Math.sin(t * 2.4) + 0.15 * Math.sin(t * 3.7 + 0.5);
          const b = Math.max(0, bounce) * 0.55;
          const sway = Math.sin(t * 1.7);
          p.squash = -0.12 - b * 0.16;
          p.glow = 0.88 + b * 0.12;
          p.energy = 0.75 + b * 0.28;
          p.mouth_smile = 0.88 + b * 0.1;
          p.look_x = sway * 0.16;
          p.look_y = -0.02 + b * 0.05;
          p.blush = 0.12 + b * 0.16;
          p.hue = 38 + b * 10;
        },
      },
      laugh: {
        label: "laugh",
        hue: 38, glow: 1, squash: -0.34, energy: 1.1,
        look_x: 0, look_y: 0.06, eye_l: 0.1, eye_r: 0.1, brow_l: 0.35, brow_r: 0.35,
        mouth_open: 0.75, mouth_smile: 1, mouth_wide: 0.05,
        eyes: "crescent", mouth: "laugh", brows: "none", blush: 0.3,
        loop(t, p) {
          // ha-ha rhythm: sharp squash + mouth flap
          const ha = Math.abs(Math.sin(t * 5.4));
          const he = Math.abs(Math.sin(t * 5.4 + 0.55));
          const guff = Math.max(ha, he * 0.9);
          p.squash = -0.2 - guff * 0.28;
          p.mouth_open = 0.45 + guff * 0.5;
          p.look_y = 0.02 + guff * 0.14;
          p.look_x = Math.sin(t * 5.4) * 0.1;
          p.energy = 0.9 + guff * 0.4;
          p.glow = 0.85 + guff * 0.15;
          p.blush = 0.2 + guff * 0.35;
          p.hue = 34 + guff * 12;
        },
      },
      excited: {
        label: "excited",
        hue: 46, glow: 1, squash: 0.18, energy: 1.05,
        look_x: 0, look_y: -0.08, eye_l: 1, eye_r: 1, brow_l: 0.55, brow_r: 0.55,
        mouth_open: 0.45, mouth_smile: 0.8, mouth_wide: 0.1,
        eyes: "soft", mouth: "laugh", brows: "raise", blush: 0.15,
        loop(t, p) {
          // soft uneven bounce — organic, not metronome
          const hop = 0.55 + 0.45 * Math.sin(t * 2.8) + 0.2 * Math.sin(t * 4.1 + 0.7);
          const bounce = Math.max(0, hop) * 0.55;
          p.squash = 0.04 + bounce * 0.28 + Math.sin(t * 1.6) * 0.04;
          p.mouth_open = 0.35 + bounce * 0.35 + Math.sin(t * 3.3) * 0.06;
          p.mouth_wide = 0.08 + bounce * 0.1;
          p.energy = 0.9 + bounce * 0.28;
          p.glow = 0.88 + bounce * 0.12;
          p.look_x = Math.sin(t * 1.35) * 0.14 + Math.sin(t * 2.4) * 0.05;
          p.look_y = -0.1 + bounce * 0.08;
          p.hue = 42 + bounce * 10;
          p.blush = 0.12 + bounce * 0.14;
        },
      },
      wink: {
        label: "wink",
        hue: 30, glow: 0.86, squash: -0.08, energy: 0.75,
        look_x: 0.25, look_y: 0, eye_l: 1, eye_r: 1, brow_l: 0.15, brow_r: -0.15,
        mouth_open: 0, mouth_smile: 0.85, mouth_wide: 0,
        eyes: "wink", mouth: "smirk", brows: "none", blush: 0.2,
        loop(t, p) {
          // cycle: open → wink shut → open (not stuck closed)
          const phase = (t % 1.8) / 1.8; // ~1.8s cycle
          let openR = 1;
          if (phase > 0.55 && phase < 0.78) openR = 0.05;       // closed wink
          else if (phase >= 0.78 && phase < 0.88) openR = 0.45;  // reopening
          p.eye_r = openR;
          p.eye_l = 1;
          p.squash = -0.05 + Math.sin(t * 1.6) * 0.06;
          p.look_x = 0.2 + Math.sin(t * 1.05) * 0.08;
          p.mouth_smile = openR < 0.3 ? 0.95 : 0.8;

        },
      },
      smug: {
        label: "smug",
        hue: 32, glow: 0.78, squash: -0.12, energy: 0.68,
        look_x: 0.38, look_y: -0.06, eye_l: 1, eye_r: 1, brow_l: 0.4, brow_r: 0,
        mouth_open: 0, mouth_smile: 0.6, mouth_wide: 0,
        eyes: "open", mouth: "smirk", brows: "one", blush: 0.08,
        loop(t, p) {
          const nod = Math.sin(t * 0.85);
          p.look_x = 0.32 + nod * 0.12;
          p.look_y = -0.04 + Math.sin(t * 1.05) * 0.05;
          p.squash = -0.08 + Math.sin(t * 1.2) * 0.07;
          p.glow = 0.7 + Math.sin(t * 1.2) * 0.08;
          p.mouth_smile = 0.55 + Math.abs(nod) * 0.1;

        },
      },

      love: {
        label: "love",
        hue: 348, glow: 1, squash: -0.12, energy: 0.85,
        look_x: 0, look_y: 0, eye_l: 1, eye_r: 1, brow_l: 0.15, brow_r: 0.15,
        mouth_open: 0, mouth_smile: 0.75, mouth_wide: 0,
        eyes: "heart", mouth: "smile", brows: "none", blush: 0.85,
        loop(t, p) {
          // double heartbeat
          const beat =
            Math.pow(Math.max(0, Math.sin(t * 3.4)), 0.45) * 0.7 +
            Math.pow(Math.max(0, Math.sin(t * 3.4 - 0.35)), 0.6) * 0.45;
          p.squash = -0.04 - beat * 0.18;
          p.glow = 0.78 + beat * 0.28;
          p.energy = 0.7 + beat * 0.4;
          p.hue = 338 + beat * 18;
          p.blush = 0.55 + beat * 0.45;
          p.mouth_smile = 0.65 + beat * 0.2;
          p.look_y = -0.02 + beat * 0.05;
        },
      },
      shy: {
        label: "shy",
        hue: 8, glow: 0.7, squash: 0.08, energy: 0.55,
        look_x: 0.42, look_y: 0.32, eye_l: 1, eye_r: 1, brow_l: 0, brow_r: 0,
        mouth_open: 0, mouth_smile: 0.35, mouth_wide: 0,
        eyes: "soft", mouth: "smile", brows: "none", blush: 0.9,
        loop(t, p) {
          // glance away, then a tiny peek — soft eyes + blush ≠ idle
          const peek = Math.pow(Math.max(0, Math.sin(t * 0.9)), 6);
          p.look_x = 0.45 - peek * 0.35;
          p.look_y = 0.34 - peek * 0.22;
          p.squash = 0.06 + Math.sin(t * 1.1) * 0.05 - peek * 0.04;
          p.blush = 0.75 + Math.sin(t * 1.4) * 0.12 + peek * 0.1;
          p.mouth_smile = 0.28 + peek * 0.2;
          p.glow = 0.62 + peek * 0.12;
          p.hue = 6 + peek * 8;
          if (Math.sin(t * 0.45) > 0.92) { p.eye_l = 0.15; p.eye_r = 0.15; }
        },
      },
      curious: {
        label: "curious",
        hue: 48, glow: 0.84, squash: 0.18, energy: 0.9,
        look_x: 0.55, look_y: -0.15, eye_l: 1, eye_r: 1, brow_l: 0.8, brow_r: 0.15,
        mouth_open: 0.08, mouth_smile: 0.1, mouth_wide: 0.35,
        eyes: "soft", mouth: "O", brows: "quirk", blush: 0,
        loop(t, p) {
          // investigate: dart look, lean in, tiny “ooh”
          const dart = Math.sin(t * 1.4);
          const lean = (Math.sin(t * 2.1) + 1) / 2;
          const notice = Math.pow(Math.max(0, Math.sin(t * 0.85)), 10);
          p.look_x = 0.35 + dart * 0.45 + notice * 0.15;
          p.look_y = -0.12 + Math.sin(t * 1.7) * 0.12 - notice * 0.08;
          p.squash = 0.1 + lean * 0.18 + notice * 0.12;
          p.energy = 0.75 + lean * 0.25 + notice * 0.2;
          p.glow = 0.72 + lean * 0.18 + notice * 0.15;
          p.mouth_wide = 0.28 + lean * 0.2 + notice * 0.25;
          p.hue = 44 + lean * 10;
          if (Math.sin(t * 0.5) > 0.94) { p.eye_l = 0.12; p.eye_r = 0.12; }

        },
      },

      sad: {
        label: "sad",
        hue: 215, glow: 0.32, squash: -0.18, energy: 0.38,
        look_x: 0, look_y: 0.4, eye_l: 1, eye_r: 1, brow_l: 0.7, brow_r: 0.7,
        mouth_open: 0, mouth_smile: -1, mouth_wide: 0,
        eyes: "open", mouth: "frown", brows: "sad", blush: 0, tear: 0.7,
        loop(t, p) {
          // slow sigh + droop
          const sigh = (Math.sin(t * 0.7) + 1) / 2;
          p.squash = -0.12 - sigh * 0.14;
          p.look_y = 0.34 + sigh * 0.12;
          p.look_x = Math.sin(t * 0.35) * 0.08;
          p.glow = 0.24 + sigh * 0.08;
          p.energy = 0.3 + sigh * 0.12;
          p.hue = 210 + sigh * 10;
          p.tear = 0.45 + sigh * 0.45;
          if (Math.sin(t * 0.38) > 0.9) { p.eye_l = 0.15; p.eye_r = 0.15; }
        },
      },
      tired: {
        label: "tired",
        hue: 228, glow: 0.3, squash: -0.28, energy: 0.4,
        look_x: 0, look_y: 0.28, eye_l: 0.35, eye_r: 0.35, brow_l: 0, brow_r: 0,
        mouth_open: 0.08, mouth_smile: -0.15, mouth_wide: 0,
        eyes: "heavy", mouth: "flat", brows: "none", blush: 0,
        loop(t, p) {
          // heavy deflate + long sigh
          const breath = (Math.sin(t * 0.65) + 1) / 2;
          const sigh = Math.pow(Math.max(0, Math.sin(t * 0.55)), 8);
          p.squash = -0.2 - breath * 0.14 - sigh * 0.08;
          p.look_y = 0.22 + breath * 0.12;
          p.look_x = Math.sin(t * 0.4) * 0.06;
          p.glow = 0.22 + breath * 0.1;
          p.energy = 0.28 + breath * 0.14;
          p.hue = 222 + breath * 12;
          p.mouth_open = 0.05 + sigh * 0.45;
          p.mouth_smile = -0.1 - sigh * 0.15;
          if (sigh > 0.4) p.mouth = "speak";
          else p.mouth = "flat";

        },
      },
      sleepy: {
        label: "sleepy",
        hue: 255, glow: 0.28, squash: -0.38, energy: 0.32,
        look_x: 0, look_y: 0.2, eye_l: 0.1, eye_r: 0.1, brow_l: 0, brow_r: 0,
        mouth_open: 0.05, mouth_smile: 0.1, mouth_wide: 0,
        eyes: "line", mouth: "flat", brows: "none", blush: 0, zzz: 1,
        loop(t, p) {
          // nodding off + rare yawn
          const nod = (Math.sin(t * 0.9) + 1) / 2;
          const yawn = Math.pow(Math.max(0, Math.sin(t * 0.45)), 12);
          p.squash = -0.28 - nod * 0.16 - yawn * 0.06;
          p.look_y = 0.16 + nod * 0.14;
          p.glow = 0.2 + nod * 0.1;
          p.energy = 0.22 + nod * 0.14;
          p.hue = 248 + nod * 14;
          p.zzz = 0.65 + nod * 0.35;
          if (yawn > 0.25) {
            p.mouth = "O";
            p.mouth_wide = 0.35 + yawn * 0.55;
            p.mouth_open = 0.2;
          } else {
            p.mouth = "flat";
            p.mouth_wide = 0;
            p.mouth_open = 0.04;
          }
        },
      },
      annoyed: {
        label: "annoyed",
        hue: 22, glow: 0.5, squash: -0.04, energy: 0.58,
        look_x: -0.45, look_y: 0.08, eye_l: 1, eye_r: 1, brow_l: -0.5, brow_r: -0.25,
        mouth_open: 0, mouth_smile: -0.35, mouth_wide: 0,
        eyes: "heavy", mouth: "flat", brows: "angry", blush: 0,
        loop(t, p) {
          // unimpressed side-glance + tiny scoff — heavy lids ≠ focused
          const scoff = Math.pow(Math.max(0, Math.sin(t * 0.7)), 10);
          p.look_x = -0.4 + Math.sin(t * 0.55) * 0.08;
          p.look_y = 0.06 + scoff * 0.04;
          p.squash = -0.02 + Math.sin(t * 1.0) * 0.05 - scoff * 0.04;
          p.glow = 0.42 + scoff * 0.1;
          p.mouth_smile = -0.3 - scoff * 0.2;
          if (Math.sin(t * 0.48) > 0.93) { p.eye_l = 0.15; p.eye_r = 0.15; }

        },
      },
      angry: {
        label: "angry",
        hue: 4, glow: 0.85, squash: 0.1, energy: 1.05,
        look_x: 0, look_y: -0.05, eye_l: 1, eye_r: 1, brow_l: -1, brow_r: -1,
        mouth_open: 0.15, mouth_smile: -0.75, mouth_wide: 0.05,
        eyes: "open", mouth: "frown", brows: "angry", blush: 0,
        loop(t, p) {
          // heat pulse + organic shake
          const heat = (Math.sin(t * 2.6) + 1) / 2;
          const shake = Math.sin(t * 4.2) * 0.5 + Math.sin(t * 7.1) * 0.3;
          p.squash = 0.06 + heat * 0.14 + shake * 0.04;
          p.glow = 0.65 + heat * 0.3;
          p.energy = 0.85 + heat * 0.35;
          p.hue = 2 + heat * 10;
          p.look_x = shake * 0.08;
          p.look_y = -0.04 + heat * 0.04;
          if (heat > 0.85) { p.mouth = "speak"; p.mouth_open = 0.35 + heat * 0.25; }
          else { p.mouth = "frown"; p.mouth_open = 0.1; }

        },
      },
      disgust: {
        label: "disgust",
        hue: 105, glow: 0.42, squash: -0.14, energy: 0.6,
        look_x: 0.15, look_y: 0.18, eye_l: 1, eye_r: 1, brow_l: -0.45, brow_r: -0.3,
        mouth_open: 0.15, mouth_smile: -0.5, mouth_wide: 0.2,
        eyes: "heavy", mouth: "wavy", brows: "angry", blush: 0,
        loop(t, p) {
          // recoil + tongue-out wavy mouth
          const ugh = (Math.sin(t * 1.5) + 1) / 2;
          const recoil = Math.pow(Math.max(0, Math.sin(t * 0.95)), 6);
          p.squash = -0.08 - ugh * 0.1 - recoil * 0.1;
          p.look_y = 0.12 + ugh * 0.1;
          p.look_x = 0.1 + Math.sin(t * 1.2) * 0.12;
          p.mouth_wide = 0.18 + ugh * 0.22;
          p.glow = 0.34 + ugh * 0.12;
          p.hue = 100 + ugh * 16;
          p.energy = 0.5 + recoil * 0.2;

        },
      },
      confused: {
        label: "confused",
        hue: 88, glow: 0.72, squash: 0.12, energy: 0.85,
        look_x: 0.25, look_y: 0, eye_l: 1, eye_r: 1, brow_l: 0.85, brow_r: -0.4,
        mouth_open: 0.1, mouth_smile: 0, mouth_wide: 0.12,
        eyes: "open", mouth: "wavy", brows: "quirk", blush: 0, ask: 0.7,
        loop(t, p) {
          // lost look: dart + wobble + ?
          const dart = Math.sin(t * 1.55);
          const tip = Math.pow(Math.max(0, Math.sin(t * 0.8)), 9);
          p.look_x = dart * 0.5;
          p.look_y = Math.sin(t * 1.1) * 0.12 + tip * 0.08;
          p.squash = 0.08 + Math.sin(t * 1.8) * 0.12 + tip * 0.08;
          p.energy = 0.7 + Math.abs(dart) * 0.2;
          p.glow = 0.6 + tip * 0.2;
          p.hue = 82 + tip * 16;
          p.mouth_wide = 0.1 + Math.abs(dart) * 0.1;
          p.ask = 0.55 + tip * 0.4;
          if (Math.sin(t * 0.55) > 0.94) { p.eye_l = 0.12; p.eye_r = 0.12; }
        },
      },
      scared: {
        label: "scared",
        // ≠ surprised: wide eyes, worried brows, small O, cower, sweat
        hue: 172, glow: 0.48, squash: -0.2, energy: 1.05,
        look_x: 0, look_y: -0.08, eye_l: 1, eye_r: 1, brow_l: 0.75, brow_r: 0.75,
        mouth_open: 0.12, mouth_smile: -0.25, mouth_wide: 0.22,
        eyes: "wide", mouth: "O", brows: "sad", blush: 0, sweat: 1,
        loop(t, p) {
          // uneven shiver + shrink (cower), not a surprise pop
          const shiver = Math.sin(t * 7.4) * 0.45 + Math.sin(t * 11.2 + 0.35) * 0.4;
          const dread = (Math.sin(t * 1.15) + 1) / 2;
          p.squash = -0.12 - dread * 0.18 + Math.abs(shiver) * 0.05;
          p.look_x = shiver * 0.24;
          p.look_y = -0.08 + Math.abs(shiver) * 0.05;
          p.glow = 0.36 + dread * 0.18;
          p.energy = 0.88 + Math.abs(shiver) * 0.35;
          p.hue = 165 + dread * 16;
          p.sweat = 0.75 + dread * 0.25;
          // lips chatter: tiny O ↔ wavy
          if (Math.abs(shiver) > 0.48) {
            p.mouth = "wavy";
            p.mouth_wide = 0.12 + dread * 0.1;
            p.mouth_open = 0.05;
          } else {
            p.mouth = "O";
            p.mouth_wide = 0.16 + dread * 0.14;
            p.mouth_open = 0.1;
          }
        },
      },
      surprised: {
        label: "surprised",
        hue: 50, glow: 1, squash: 0.36, energy: 0.95,
        look_x: 0, look_y: -0.16, eye_l: 1, eye_r: 1, brow_l: 0.95, brow_r: 0.95,
        mouth_open: 0.08, mouth_smile: 0, mouth_wide: 0.95,
        eyes: "soft", mouth: "O", brows: "raise", blush: 0,
        loop(t, p) {
          const pop = (Math.sin(t * 2.4) + 1) / 2;
          const jolt = Math.pow(Math.max(0, Math.sin(t * 1.1)), 7);
          p.squash = 0.26 + pop * 0.14 + jolt * 0.12;
          p.mouth_wide = 0.75 + pop * 0.2 + jolt * 0.1;
          p.glow = 0.85 + pop * 0.15;
          p.energy = 0.85 + pop * 0.2 + jolt * 0.2;
          p.look_y = -0.14 - jolt * 0.08;
          p.hue = 46 + pop * 10;
        },
      },
};

function heartPath(cx, cy, s) {
      // Classic ♥ (Material-like), visual center at (cx, cy)
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
      const eyes = s.eyes || "open";
      const mouth = s.mouth || "smile";
      const brows = s.brows || "none";
      const blush = s.blush || 0;

      // Face lives in a stable band inside the blob
      const faceH = Math.max(ry * 0.92, 48);
      const eyeY = cy - faceH * 0.18;
      const mouthY = cy + faceH * 0.34;
      const gap = Math.min(rx * 0.3, 28);
      const lookX = s.look_x * rx * 0.1;
      const lookY = clamp(s.look_y, -1, 0.55) * faceH * 0.05;

      if (blush > 0.04) {
        const by = cy + faceH * 0.08;
        g.appendChild(el("ellipse", {
          cx: cx - gap * 1.25 + lookX * 0.3, cy: by, rx: 13, ry: 7,
          fill: "#ff6b7a", opacity: blush * 0.4,
        }));
        g.appendChild(el("ellipse", {
          cx: cx + gap * 1.25 + lookX * 0.3, cy: by, rx: 13, ry: 7,
          fill: "#ff6b7a", opacity: blush * 0.4,
        }));
      }

      // sleepy: classic zzzz rising
      const zzz = s.zzz || 0;
      if (zzz > 0.08) {
        for (let i = 0; i < 4; i++) {
          const rise = ((t * 16 + i * 14) % 42);
          const zx = cx + 26 + i * 7 + Math.sin(t * 1.3 + i) * 2;
          const zy = cy - 14 - rise;
          const size = 9 + i * 2.2;
          const node = g.appendChild(el("text", {
            x: zx,
            y: zy,
            fill: "#1a1008",
            opacity: Math.max(0.08, zzz * 0.7 - rise / 50),
            "font-size": size,
            "font-family": "Syne, Outfit, sans-serif",
            "font-weight": 800,
            "font-style": "italic",
          }));
          node.textContent = "z";
        }
      }

      // confused: ? rising (signature like zzzz)
      const ask = s.ask || 0;
      if (ask > 0.08) {
        for (let i = 0; i < 2; i++) {
          const rise = ((t * 12 + i * 18) % 34);
          const qx = cx + 30 + i * 10;
          const qy = cy - 18 - rise;
          const node = g.appendChild(el("text", {
            x: qx,
            y: qy,
            fill: "#1a1008",
            opacity: Math.max(0.1, ask * 0.75 - rise / 42),
            "font-size": 14 + i * 3,
            "font-family": "Syne, Outfit, sans-serif",
            "font-weight": 800,
          }));
          node.textContent = "?";
        }
      }

      function drawBrows(side, ex, ey, kind) {
        if (kind === "none") return;
        const half = 11;
        const outer = side === "L" ? ex - half : ex + half;
        const inner = side === "L" ? ex + half : ex - half;
        let yO = ey - 13;
        let yI = ey - 13;
        let ctrlY = ey - 15;
        if (kind === "raise") { yO = ey - 14; yI = ey - 17; ctrlY = ey - 19; }
        // smug: both brows present — left arched up, right flat
        if (kind === "one") {
          if (side === "L") { yO = ey - 14; yI = ey - 18; ctrlY = ey - 20; }
          else { yO = ey - 12; yI = ey - 12; ctrlY = ey - 13; }
        }
        if (kind === "sad") { yO = ey - 9; yI = ey - 18; ctrlY = ey - 16; }
        if (kind === "angry") { yO = ey - 17; yI = ey - 9; ctrlY = ey - 11; }
        if (kind === "quirk") {
          if (side === "L") { yO = ey - 12; yI = ey - 17; ctrlY = ey - 18; }
          else { yO = ey - 14; yI = ey - 11; ctrlY = ey - 12; }
        }
        g.appendChild(el("path", {
          d: `M${outer} ${yO} Q${ex} ${ctrlY} ${inner} ${yI}`,
          fill: "none", stroke: ink, "stroke-width": 2.6, "stroke-linecap": "round",
        }));
      }

      function drawEye(side, open) {
        const ex = cx + (side === "L" ? -gap : gap) + lookX;
        const ey = eyeY + lookY;
        drawBrows(side, ex, ey, brows);

        // wink: right eye closes as crescent only while winking
        if (eyes === "wink" && side === "R" && open < 0.35) {
          g.appendChild(el("path", {
            d: `M${ex - 11} ${ey + 2} Q${ex} ${ey - 8.5} ${ex + 11} ${ey + 2}`,
            fill: "none", stroke: ink, "stroke-width": 3.9, "stroke-linecap": "round",
          }));
          return;
        }

        if (eyes === "crescent") {
          g.appendChild(el("path", {
            d: `M${ex - 11} ${ey + 2} Q${ex} ${ey - 8.5} ${ex + 11} ${ey + 2}`,
            fill: "none", stroke: ink, "stroke-width": 3.9, "stroke-linecap": "round",
          }));
          return;
        }

        if (eyes === "line" || eyes === "heavy" || open < 0.28) {
          // heavy = droopy tired lids; line = flat sleepy
          const bend = eyes === "heavy" ? 3.2 : eyes === "line" ? -1.2 : 0;
          const half = eyes === "heavy" ? 11 : 10;
          g.appendChild(el("path", {
            d: `M${ex - half} ${ey - (eyes === "heavy" ? 1 : 0)} Q${ex} ${ey + bend} ${ex + half} ${ey - (eyes === "heavy" ? 1 : 0)}`,
            fill: "none", stroke: ink, "stroke-width": eyes === "heavy" ? 4 : 3.5, "stroke-linecap": "round",
          }));
          return;
        }

        if (eyes === "heart") {
          const pulse = 1 + Math.max(0, blush - 0.45) * 0.18;
          g.appendChild(el("path", {
            d: heartPath(ex, ey + 1, 10.5 * pulse),
            fill: ink,
          }));
          return;
        }

        // open / soft / wide / wink — same size round dots (scared set the size)
        const r = 12.8;
        if (open > 0.82) {
          g.appendChild(el("circle", { cx: ex, cy: ey, r, fill: ink }));
          return;
        }
        g.appendChild(el("ellipse", {
          cx: ex, cy: ey, rx: r, ry: Math.max(2.4, r * open), fill: ink,
        }));
      }

      drawEye("L", s.eye_l);
      drawEye("R", s.eye_r);

      // tear attached to the face (sad)
      const tear = s.tear || 0;
      if (tear > 0.08) {
        const tx = cx + gap * 0.55 + lookX;
        const ty = eyeY + lookY + 11 + tear * 4;
        g.appendChild(el("path", {
          d: `M${tx} ${ty - 4}
              Q${tx - 3.2} ${ty + 1} ${tx} ${ty + 5.5}
              Q${tx + 3.2} ${ty + 1} ${tx} ${ty - 4}Z`,
          fill: "#7ec8ff",
          opacity: 0.4 + tear * 0.45,
        }));
      }

      // sweat drop on temple (scared) — clear of the eye, not a stain
      const sweat = s.sweat || 0;
      if (sweat > 0.08) {
        const sx = cx + gap + 20 + lookX * 0.2;
        const sy = eyeY + lookY - 22;
        g.appendChild(el("path", {
          d: `M${sx} ${sy}
              Q${sx - 3.2} ${sy + 5.5} ${sx} ${sy + 10}
              Q${sx + 3.2} ${sy + 5.5} ${sx} ${sy}Z`,
          fill: "#c5ebff",
          stroke: "#7eb8d8",
          "stroke-width": 0.8,
          opacity: 0.55 + sweat * 0.35,
        }));
      }

      const mx = cx + lookX * 0.35;
      const my = mouthY;
      const smile = s.mouth_smile;
      const open = s.mouth_open;
      const wide = s.mouth_wide;

      if (mouth === "smile") {
        const bend = Math.max(0.35, smile) * 10;
        const half = 11 + Math.abs(smile) * 5;
        g.appendChild(el("path", {
          d: `M${mx - half} ${my - bend * 0.1} Q${mx} ${my + bend} ${mx + half} ${my - bend * 0.1}`,
          fill: "none", stroke: ink, "stroke-width": 3.8, "stroke-linecap": "round",
        }));
        return;
      }

      if (mouth === "smirk") {
        // one-sided knowing smile
        g.appendChild(el("path", {
          d: `M${mx - 6} ${my + 2} Q${mx + 4} ${my + 10} ${mx + 13} ${my - 2}`,
          fill: "none", stroke: ink, "stroke-width": 3.7, "stroke-linecap": "round",
        }));
        return;
      }

      if (mouth === "frown") {
        g.appendChild(el("path", {
          d: `M${mx - 11} ${my + 6} Q${mx} ${my - 7} ${mx + 11} ${my + 6}`,
          fill: "none", stroke: ink, "stroke-width": 3.6, "stroke-linecap": "round",
        }));
        return;
      }

      if (mouth === "flat") {
        g.appendChild(el("path", {
          d: `M${mx - 9} ${my} L${mx + 9} ${my}`,
          fill: "none", stroke: ink, "stroke-width": 3.4, "stroke-linecap": "round",
        }));
        return;
      }

      if (mouth === "wavy") {
        const amp = 5 + (wide || 0) * 8;
        g.appendChild(el("path", {
          d: `M${mx - 13} ${my + 2} Q${mx - 5} ${my - amp} ${mx} ${my + 3} Q${mx + 5} ${my + amp + 2} ${mx + 13} ${my + 1}`,
          fill: "none", stroke: ink, "stroke-width": 3.5, "stroke-linecap": "round",
        }));
        return;
      }

      if (mouth === "laugh") {
        const w = 12 + open * 6;
        const h = Math.min(7 + open * 5, 13);
        g.appendChild(el("path", {
          d: `M${mx - w} ${my}
              Q${mx} ${my - 5} ${mx + w} ${my}
              Q${mx + w} ${my + h} ${mx} ${my + h + 1}
              Q${mx - w} ${my + h} ${mx - w} ${my} Z`,
          fill: ink,
        }));
        return;
      }

      if (mouth === "O") {
        const r = 5.5 + wide * 8;
        g.appendChild(el("circle", { cx: mx, cy: my + 1, r, fill: ink }));
        return;
      }

      // speak / default open capsule
      const w = 6 + open * 10 + wide * 4;
      const h = Math.min(2.5 + open * 9, 11);
      g.appendChild(el("ellipse", { cx: mx, cy: my, rx: w, ry: h, fill: ink }));
}

function resolveEmotion(name) {
  return EMOTIONS[name] ? name : "idle";
}

export function createAvatarController({ bloom, body, face, orbRoot, j0, j1, j2 }) {
  const pose = {
    ...EMOTIONS.idle,
    energy: 0.8,
    eyes: "open",
    mouth: "smile",
    brows: "none",
    blush: 0,
    tear: 0,
    zzz: 0,
    ask: 0,
    sweat: 0,
  };
  const target = { ...pose };
  let active = "idle";
  let emotionSince = 0;

  function copyBase(from, to) {
    for (const k of KEYS) to[k] = from[k];
    to.energy = from.energy ?? 0.85;
    to.label = from.label || active;
    to.eyes = from.eyes || "open";
    to.mouth = from.mouth || "smile";
    to.brows = from.brows || "none";
    to.blush = from.blush || 0;
    to.tear = from.tear || 0;
    to.zzz = from.zzz || 0;
    to.ask = from.ask || 0;
    to.sweat = from.sweat || 0;
  }

  function setEmotion(name) {
    const next = resolveEmotion(name);
    if (next === active) return;
    // Keep previous discrete face briefly so the morph feels continuous.
    fromFace = {
      eyes: pose.eyes || "open",
      mouth: pose.mouth || "smile",
      brows: pose.brows || "none",
    };
    active = next;
    emotionSince = performance.now() / 1000;
    copyBase(EMOTIONS[active], target);
    toFace = {
      eyes: target.eyes || "open",
      mouth: target.mouth || "smile",
      brows: target.brows || "none",
    };
    faceBlend = 0;
  }

  let fromFace = { eyes: "open", mouth: "smile", brows: "none" };
  let toFace = { eyes: "open", mouth: "smile", brows: "none" };
  let faceBlend = 1;

  function setGradLocal(hue, glow) {
    const L = 52 + glow * 16;
    j0.setAttribute("stop-color", hsl(hue, 90, Math.min(92, L + 20)));
    j1.setAttribute("stop-color", hsl(hue, 86, L));
    j2.setAttribute("stop-color", hsl(hue, 78, Math.max(28, L - 22)));
    bloom.setAttribute("fill", hsl(hue, 92, L + 8));
  }

  function tick(now) {
    const t = now / 1000;
    const local = t - emotionSince;
    const e = EMOTIONS[active] || EMOTIONS.idle;
    // Slow, continuous morph (was ~1.85× — felt abrupt).
    const ease = 1 - Math.exp(-1.15 * (1 / 60));
    faceBlend = Math.min(1, faceBlend + 1 / 60 / 0.85);

    for (const k of KEYS) {
      if (k === "eye_l" || k === "eye_r") continue;
      pose[k] = lerp(pose[k], target[k], ease);
    }
    pose.energy = lerp(pose.energy ?? 0.85, target.energy ?? 0.85, ease);
    pose.blush = lerp(pose.blush ?? 0, target.blush ?? 0, ease);
    pose.tear = lerp(pose.tear ?? 0, target.tear ?? 0, ease);
    pose.zzz = lerp(pose.zzz ?? 0, target.zzz ?? 0, ease);
    pose.ask = lerp(pose.ask ?? 0, target.ask ?? 0, ease);
    pose.sweat = lerp(pose.sweat ?? 0, target.sweat ?? 0, ease);

    // Discrete face parts crossfade after the body has started moving.
    if (faceBlend < 0.4) {
      pose.eyes = fromFace.eyes;
      pose.mouth = fromFace.mouth;
      pose.brows = fromFace.brows;
    } else {
      pose.eyes = toFace.eyes || e.eyes || "open";
      pose.mouth = toFace.mouth || e.mouth || "smile";
      pose.brows = toFace.brows || e.brows || "none";
    }

    const live = { ...pose };
    live.blush = target.blush ?? 0;
    live.tear = target.tear ?? 0;
    live.zzz = target.zzz ?? 0;
    live.ask = target.ask ?? 0;
    live.sweat = target.sweat ?? 0;
    live.mouth = pose.mouth;
    live.eyes = pose.eyes;
    live.brows = pose.brows;
    live.eye_l = target.eye_l ?? 1;
    live.eye_r = target.eye_r ?? 1;
    if (e.loop) e.loop(local, live);

    for (const k of KEYS) {
      if (k === "eye_l" || k === "eye_r") continue;
      pose[k] = lerp(pose[k], live[k], k === "hue" ? 0.14 : 0.22);
    }
    for (const k of ["eye_l", "eye_r"]) {
      const want = live[k];
      const closing = want < 0.35 || pose[k] < 0.35;
      pose[k] = lerp(pose[k], want, closing ? 0.55 : 0.22);
    }
    pose.energy = lerp(pose.energy, live.energy ?? pose.energy, 0.22);
    pose.blush = lerp(pose.blush ?? 0, live.blush ?? 0, 0.22);
    pose.tear = lerp(pose.tear ?? 0, live.tear ?? 0, 0.22);
    pose.zzz = lerp(pose.zzz ?? 0, live.zzz ?? 0, 0.22);
    pose.ask = lerp(pose.ask ?? 0, live.ask ?? 0, 0.22);
    pose.sweat = lerp(pose.sweat ?? 0, live.sweat ?? 0, 0.22);
    if (live.mouth) pose.mouth = live.mouth;
    if (live.eyes) pose.eyes = live.eyes;
    if (live.brows) pose.brows = live.brows;

    const mood = pose.energy ?? 0.8;
    const bob = Math.sin(t * (0.9 + mood * 0.6)) * (2.8 + mood * 2.2);
    const sway = Math.sin(t * 0.75) * (1.1 + mood * 1.0);
    const rot = Math.sin(t * 0.55) * (1.4 + mood * 1.4);
    orbRoot.setAttribute("transform", `translate(${sway} ${bob}) rotate(${rot} 160 112)`);

    const cx = 160;
    const cy = 112;
    const baseR = 62;
    const energy = Math.min(1.05, mood * 0.8);
    setGradLocal(pose.hue, pose.glow);
    bloom.setAttribute("d", blobPath(cx, cy, baseR * 1.18, baseR * 1.1, t * 0.9, energy * 0.7, pose.squash));
    body.setAttribute("d", blobPath(cx, cy, baseR, baseR * 0.94, t, energy, pose.squash));

    const rx = baseR * (1 - pose.squash * 0.34);
    const ry = baseR * 0.94 * (1 + pose.squash * 0.4);
    drawFace(face, pose, cx, cy, rx, ry, t);
  }

  setEmotion("idle");
  return { setEmotion, tick, getActive: () => active };
}
