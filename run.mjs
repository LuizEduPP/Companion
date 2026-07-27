#!/usr/bin/env node
/**
 * Companion — single entry.
 *   node run.mjs              # brain + sense + orb
 *   node run.mjs --hot        # same + file watchers
 *   node run.mjs brain|sense|orb|electron-ensure
 * Electron loads this same file as the orb main process.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { envFlag, requireFlag } from "./lib/sense/util.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SELF = join(ROOT, "run.mjs");
const PRELOAD = join(ROOT, "orb-preload.cjs");
const require = createRequire(join(ROOT, "package.json"));
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

/** Sense OS poll interval — I/O loop, not speech policy. */
const SENSE_POLL_MS = 1500;

/* ─── hot reload helpers ─── */

function hotEnabled() {
  return process.argv.includes("--hot");
}

function shouldSkip(name) {
  if (name === ".env") return false;
  return (
    name === "node_modules" ||
    name === "data" ||
    name === ".git" ||
    name === "dist" ||
    name.startsWith(".")
  );
}

function extname(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

const WATCH_SUFFIXES = new Set([
  ".mjs",
  ".js",
  ".cjs",
  ".html",
  ".css",
  ".md",
  ".json",
]);

function walkFiles(root, out) {
  if (!existsSync(root)) return;
  let st;
  try {
    st = statSync(root);
  } catch {
    return;
  }
  if (st.isFile()) {
    const base = root.split(/[/\\]/).pop() || "";
    if (base === ".env" || WATCH_SUFFIXES.has(extname(base))) out.push(root);
    return;
  }
  if (!st.isDirectory()) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (shouldSkip(ent.name)) continue;
    const p = join(root, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else if (ent.isFile()) {
      if (ent.name === ".env" || WATCH_SUFFIXES.has(extname(ent.name))) out.push(p);
    }
  }
}

function snapshotMtimes(roots) {
  const files = [];
  for (const root of roots) walkFiles(root, files);
  const map = new Map();
  for (const f of files) {
    try {
      map.set(f, statSync(f).mtimeMs);
    } catch {
      /* ignore */
    }
  }
  return map;
}

function watchMtimes({ roots, intervalMs = 600, debounceMs = 250, onChange, label = "hot" }) {
  let last = snapshotMtimes(roots);
  let timer = null;
  let pending = null;
  console.log(`[${label}] watching ${last.size} files`);
  setInterval(() => {
    const next = snapshotMtimes(roots);
    let changed = null;
    for (const [f, t] of next) {
      if (last.get(f) !== t) {
        changed = f;
        break;
      }
    }
    if (!changed && next.size !== last.size) changed = "(add/remove)";
    last = next;
    if (!changed) return;
    pending = changed;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onChange(pending), debounceMs);
  }, intervalMs);
}

/* ─── electron ensure / resolve ─── */

function electronBinName() {
  if (isWin) return "electron.exe";
  if (isMac) return "Electron.app/Contents/MacOS/Electron";
  return "electron";
}

function platformArch() {
  const a = arch() === "arm64" ? "arm64" : "x64";
  if (isWin) return `win32-${a === "arm64" ? "arm64" : "x64"}`;
  if (isMac) return `darwin-${a}`;
  return `linux-${a}`;
}

function isBinary(p) {
  if (!p || !existsSync(p)) return false;
  if (p.endsWith("cli.js") || p.endsWith("index.js")) return false;
  return true;
}

function electronVersion() {
  try {
    return require(join(ROOT, "node_modules", "electron", "package.json")).version;
  } catch {
    return null;
  }
}

function ensureElectron() {
  const electronDir = join(ROOT, "node_modules", "electron");
  if (!existsSync(electronDir)) {
    console.error("electron package missing — run yarn install first");
    process.exit(1);
  }
  const { version } = require(join(electronDir, "package.json"));
  const cache = join(homedir(), ".cache", "companion-electron", version);
  const bin = join(cache, electronBinName());
  const distLink = join(electronDir, "dist");
  const pathTxt = join(electronDir, "path.txt");
  const zipName = `electron-v${version}-${platformArch()}.zip`;

  function findZip() {
    const base = join(homedir(), ".cache", "electron");
    if (!existsSync(base)) return null;
    for (const dir of readdirSync(base)) {
      const zip = join(base, dir, zipName);
      if (existsSync(zip)) return zip;
    }
    return null;
  }

  if (!existsSync(bin)) {
    console.log(`companion: extracting electron ${version} (${platformArch()}) → ${cache}`);
    mkdirSync(cache, { recursive: true });
    let zip = findZip();
    if (!zip) {
      const r = spawnSync(process.execPath, [join(electronDir, "install.js")], {
        cwd: ROOT,
        env: {
          ...process.env,
          ELECTRON_OVERRIDE_DIST_PATH: cache,
          ELECTRON_SKIP_BINARY_DOWNLOAD: "",
        },
        stdio: "inherit",
      });
      if (r.status !== 0 || !existsSync(bin)) {
        console.error("electron download/extract failed");
        process.exit(1);
      }
    } else {
      const unzipCmd = isWin ? "tar" : "unzip";
      const unzipArgs = isWin ? ["-xf", zip, "-C", cache] : ["-o", zip, "-d", cache];
      const r = spawnSync(unzipCmd, unzipArgs, { stdio: "inherit" });
      if (r.status !== 0 || !existsSync(bin)) {
        console.error(`${unzipCmd} electron failed`);
        process.exit(1);
      }
    }
  }

  try {
    rmSync(distLink, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  symlinkSync(cache, distLink);
  writeFileSync(
    pathTxt,
    isWin ? "electron.exe" : isMac ? "Electron.app/Contents/MacOS/Electron" : "electron",
  );
  console.log(`companion: electron ready → ${bin}`);
}

function resolveElectron() {
  const override = process.env.ELECTRON_OVERRIDE_DIST_PATH;
  if (override) {
    const bin = join(override, electronBinName());
    if (isBinary(bin)) return bin;
  }
  try {
    let p = require("electron");
    if (typeof p === "string") p = p.replace(/\r?\n/g, "");
    if (isBinary(p)) return p;
  } catch {
    /* missing path.txt */
  }
  const ver = electronVersion();
  const candidates = [
    join(ROOT, "node_modules", "electron", "dist", electronBinName()),
    ver ? join(homedir(), ".cache", "companion-electron", ver, electronBinName()) : null,
  ].filter(Boolean);
  for (const c of candidates) if (isBinary(c)) return c;
  return null;
}

function distRootFromBin(binPath) {
  if (isMac) return join(binPath, "..", "..", "..");
  return dirname(binPath);
}

/* ─── sense ─── */

async function runSense() {
  const { config } = await import("./lib/config.mjs");
  const { collectActivity } = await import("./lib/sense.mjs");
  const base = `http://127.0.0.1:${config.port}`;

  async function postActivity(payload) {
    const res = await fetch(`${base}/api/pc/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`/api/pc/activity ${res.status}`);
    return res.json();
  }

  async function tick() {
    const activity = await collectActivity();
    if (activity.focus?.skip) return;
    await postActivity(activity);
  }

  console.log(`companion sense → ${base} every ${SENSE_POLL_MS}ms`);
  await tick();
  setInterval(() => {
    void tick().catch((err) => console.error("[sense]", err.message));
  }, SENSE_POLL_MS);
}

/* ─── orb launcher (node → electron) ─── */

async function runOrbLauncher() {
  const { config } = await import("./lib/config.mjs");
  let electronPath = resolveElectron();
  if (!electronPath) {
    console.log("companion: repairing electron…");
    ensureElectron();
    electronPath = resolveElectron();
  }
  if (!electronPath) {
    console.error("electron binary missing");
    process.exit(1);
  }
  const env = {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    ELECTRON_OVERRIDE_DIST_PATH:
      process.env.ELECTRON_OVERRIDE_DIST_PATH || distRootFromBin(electronPath),
  };
  // Wayland: setIgnoreMouseEvents + cursor hit-test is unreliable (scale /
  // forward). X11 ozone restores click, drag, and click-through.
  const orbArgs = ["--enable-transparent-visuals"];
  if (process.platform === "linux") {
    orbArgs.push("--ozone-platform=x11");
  }
  orbArgs.push(SELF);
  const child = spawn(electronPath, orbArgs, {
    cwd: ROOT,
    stdio: "inherit",
    env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

/* ─── orb main (inside Electron) ─── */

async function runOrbMain() {
  const { app, BrowserWindow, screen, ipcMain } = await import("electron");
  const { config, readCompanionPort } = await import("./lib/config.mjs");

  app.commandLine.appendSwitch("enable-transparent-visuals");

  const PORT = readCompanionPort();
  const URL = `http://127.0.0.1:${PORT}/`;
  const ORB_W = config.orb.width;
  const ORB_H = config.orb.height;
  const BALLOON_H = config.orb.balloonHeight;
  const title = config.orbTitle;

  function cursorInWindowSpace(win, point) {
    // Match cursor + window bounds in DIP space when fractional scale differs.
    let px = point.x;
    let py = point.y;
    try {
      if (typeof screen.screenToDipPoint === "function") {
        const dip = screen.screenToDipPoint(point);
        px = dip.x;
        py = dip.y;
      }
    } catch {
      /* keep screen px */
    }
    const b = win.getBounds();
    return { rx: px - b.x, ry: py - b.y, w: b.width, h: b.height };
  }

  function pointOverInteractive(win, balloonOpen, point) {
    const { rx, ry, w, h } = cursorInWindowSpace(win, point);
    if (rx < 0 || ry < 0 || rx >= w || ry >= h) return false;
    const balloon = balloonOpen ? BALLOON_H : 0;
    if (balloon > 0 && ry < balloon) return true;
    // Full orb pane is interactive (not only the circle) — Wayland/X11
    // scale drift made the tight circle miss and leave ignore=true forever.
    return ry >= balloon;
  }

  function createWindow() {
    const ozone =
      app.commandLine.hasSwitch("ozone-platform")
        ? app.commandLine.getSwitchValue("ozone-platform")
        : process.env.XDG_SESSION_TYPE || "default";
    // Linux/XWayland: setIgnoreMouseEvents + transparent pixels often drop
    // all input (can't drag / can't nudge). Keep the window fully interactive.
    const clickThrough = process.platform !== "linux";
    console.log(
      `[orb] size=${ORB_W}x${ORB_H} platform=${process.platform} ozone=${ozone} clickThrough=${clickThrough}`,
    );
    const display = screen.getPrimaryDisplay().workArea;
    let balloonOpen = false;
    let dragging = false;
    let lastIgnore = null;

    function winSize() {
      return balloonOpen
        ? { w: ORB_W, h: ORB_H + BALLOON_H }
        : { w: ORB_W, h: ORB_H };
    }

    const { w, h } = winSize();
    const win = new BrowserWindow({
      width: w,
      height: h,
      x: display.x + display.width - w - 24,
      y: display.y + display.height - h - 24,
      frame: false,
      transparent: true,
      hasShadow: false,
      thickFrame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: true,
      show: false,
      title,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: PRELOAD,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Ensure Linux starts accepting input (never begin in ignore=true).
    win.setIgnoreMouseEvents(false);

    function applySize(anchorBottomRight = true) {
      const size = winSize();
      const [x, y] = win.getPosition();
      const [, oldH] = win.getSize();
      win.setBounds({
        x,
        y: anchorBottomRight ? y + (oldH - size.h) : y,
        width: size.w,
        height: size.h,
      });
    }

    function syncMousePassThrough() {
      if (!clickThrough || win.isDestroyed() || dragging) return;
      const over = pointOverInteractive(
        win,
        balloonOpen,
        screen.getCursorScreenPoint(),
      );
      const ignore = !over;
      if (ignore === lastIgnore) return;
      lastIgnore = ignore;
      try {
        win.setIgnoreMouseEvents(ignore, { forward: true });
      } catch {
        win.setIgnoreMouseEvents(ignore);
      }
    }

    win.once("ready-to-show", () => {
      win.show();
      win.setIgnoreMouseEvents(false);
      setTimeout(() => {
        console.log(
          clickThrough
            ? "[orb] click-through via Electron hit-test"
            : "[orb] input always-on (linux: no ignore-mouse)",
        );
        syncMousePassThrough();
      }, 200);
    });

    ipcMain.removeAllListeners("orb:balloon");
    ipcMain.removeAllListeners("orb:arm");
    ipcMain.removeAllListeners("orb:drag");
    ipcMain.removeAllListeners("orb:drag-end");

    function armMouse() {
      if (win.isDestroyed()) return;
      if (lastIgnore !== false) {
        lastIgnore = false;
        win.setIgnoreMouseEvents(false);
      }
    }

    ipcMain.on("orb:balloon", (_e, open) => {
      const next = Boolean(open);
      if (next === balloonOpen) return;
      balloonOpen = next;
      applySize(true);
    });

    ipcMain.on("orb:arm", () => {
      armMouse();
    });

    ipcMain.on("orb:drag", (_e, { screenX, screenY, offsetX, offsetY }) => {
      armMouse();
      dragging = true;
      win.setPosition(Math.round(screenX - offsetX), Math.round(screenY - offsetY));
    });

    ipcMain.on("orb:drag-end", () => {
      dragging = false;
      lastIgnore = null;
      syncMousePassThrough();
    });

    win.loadURL(URL);
    win.webContents.on("did-fail-load", () => {
      setTimeout(() => {
        if (!win.isDestroyed()) win.loadURL(URL);
      }, 1500);
    });

    const hitPoll = clickThrough
      ? setInterval(() => {
          if (win.isDestroyed()) {
            clearInterval(hitPoll);
            return;
          }
          syncMousePassThrough();
        }, 32)
      : null;
    win.on("closed", () => {
      if (hitPoll) clearInterval(hitPoll);
    });
  }

  app.whenReady().then(createWindow);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

/* ─── supervisor (all) ─── */

async function runAll() {
  const { readCompanionPort } = await import("./lib/config.mjs");
  const HOT = hotEnabled();
  const children = new Map();
  let shuttingDown = false;
  const restarting = new Set();
  const port = readCompanionPort();
  const health = `http://127.0.0.1:${port}/api/health`;

  function run(label, args) {
    const prev = children.get(label);
    if (prev && !prev.killed) {
      try {
        prev.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout.on("data", (buf) => {
      for (const line of String(buf).split("\n").filter(Boolean)) {
        console.log(`[${label}] ${line}`);
      }
    });
    child.stderr.on("data", (buf) => {
      for (const line of String(buf).split("\n").filter(Boolean)) {
        console.error(`[${label}] ${line}`);
      }
    });
    child.on("exit", (code, signal) => {
      if (shuttingDown || restarting.has(label)) return;
      console.error(`[${label}] exited code=${code} signal=${signal}`);
      if (label === "brain" || label === "orb") shutdown(1);
    });
    children.set(label, child);
    return child;
  }

  async function killLabel(label) {
    const child = children.get(label);
    if (!child || child.killed) return;
    restarting.add(label);
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    await new Promise((r) => {
      const t = setTimeout(r, 1200);
      child.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
    try {
      if (!child.killed) child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    restarting.delete(label);
  }

  function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\ncompanion: shutting down…");
    for (const c of children.values()) {
      try {
        c.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => {
      for (const c of children.values()) {
        try {
          c.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
      process.exit(code);
    }, 1500).unref();
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  async function healthOk(url) {
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      const body = await res.json();
      return body?.service === "companion";
    } catch {
      return false;
    }
  }

  async function waitReady(url, ms = 20000) {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (await healthOk(url)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  console.log(`companion → :${port}${HOT ? " · hot reload" : ""}`);

  if (await healthOk(health)) {
    if (HOT) {
      console.error("companion already on this port — stop it first");
      process.exit(1);
    }
    console.log("brain already running — reusing");
  } else {
    run("brain", [join(ROOT, "server.mjs")]);
    if (!(await waitReady(health))) {
      console.error("brain did not become ready — abort");
      shutdown(1);
    }
  }

  run("sense", [SELF, "sense"]);
  run("orb", [SELF, "orb"]);

  if (!HOT) return;

  let brainBusy = false;
  watchMtimes({
    roots: [join(ROOT, "server.mjs"), join(ROOT, "lib"), join(ROOT, "prompts"), join(ROOT, ".env")],
    label: "hot:brain",
    onChange: async (file) => {
      if (brainBusy || shuttingDown) return;
      brainBusy = true;
      console.log(`[hot] restart brain ← ${file}`);
      try {
        await killLabel("brain");
        run("brain", [join(ROOT, "server.mjs")]);
        if (await waitReady(health)) console.log("[hot] brain ready");
        else console.error("[hot] brain failed to come back");
      } finally {
        brainBusy = false;
      }
    },
  });

  watchMtimes({
    roots: [
      SELF,
      join(ROOT, "lib", "sense.mjs"),
      join(ROOT, "lib", "sense"),
      join(ROOT, "lib", "config.mjs"),
    ],
    label: "hot:sense",
    onChange: async (file) => {
      if (shuttingDown) return;
      console.log(`[hot] restart sense ← ${file}`);
      await killLabel("sense");
      run("sense", [SELF, "sense"]);
    },
  });

  watchMtimes({
    roots: [SELF, PRELOAD],
    label: "hot:orb",
    onChange: async (file) => {
      if (shuttingDown) return;
      console.log(`[hot] restart orb ← ${file}`);
      await killLabel("orb");
      run("orb", [SELF, "orb"]);
    },
  });
}

async function runBrain() {
  if (!hotEnabled()) {
    const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
  let child = null;
  let shuttingDown = false;
  function start() {
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
  }
  process.on("SIGINT", () => {
    shuttingDown = true;
    try {
      child?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 800).unref();
  });
  console.log("companion brain · hot reload");
  start();
  watchMtimes({
    roots: [
      join(ROOT, "server.mjs"),
      join(ROOT, "lib"),
      join(ROOT, "prompts"),
      join(ROOT, "public"),
      join(ROOT, ".env"),
    ],
    label: "hot",
    onChange: (file) => {
      if (shuttingDown) return;
      console.log(`[hot] restart ← ${file}`);
      start();
    },
  });
}

/* ─── dispatch ─── */

if (process.versions.electron) {
  await runOrbMain();
} else {
  const cmd = process.argv[2] || "all";
  if (cmd === "electron-ensure" || cmd === "postinstall") ensureElectron();
  else if (cmd === "sense") await runSense();
  else if (cmd === "orb") await runOrbLauncher();
  else if (cmd === "brain" || cmd === "start") await runBrain();
  else if (cmd === "all") await runAll();
  else {
    console.error(`usage: node run.mjs [all|brain|sense|orb|electron-ensure]`);
    process.exit(2);
  }
}
