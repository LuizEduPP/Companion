import { sh, packFocus, packWindows, IO, SH_MS } from "./util.mjs";

export async function getFocus() {
  const script = [
    'tell application "System Events"',
    "set p to first process whose frontmost is true",
    "set appName to name of p",
    'set winTitle to ""',
    "try",
    "set winTitle to name of front window of p",
    "end try",
    "set pid to unix id of p",
    "return appName & character id 9 & winTitle & character id 9 & pid",
    "end tell",
  ].join("\n");
  const r = await sh("osascript", ["-e", script], { timeout: SH_MS.focus });
  if (!r.ok) return null;
  const parts = r.stdout.split("\t");
  const app = (parts[0] || "").trim();
  const title = (parts[1] || "").trim() || app;
  const pid = Number(parts[2]) || null;
  return packFocus({ app, title, pid });
}

export async function getClipboardText() {
  const r = await sh("pbpaste", [], { timeout: SH_MS.quick });
  return r.ok ? r.stdout.slice(0, IO.clipboardRaw) : "";
}

export async function getA11yFocus() {
  const script = `
tell application "System Events"
  set p to first process whose frontmost is true
  set info to ""
  try
    set f to focused UI element of p
    set n to name of f
    set r to role of f
    set v to ""
    try
      set v to value of f as text
    end try
    set info to n & character id 9 & r & character id 9 & v
  end try
  return info
end tell
`;
  const r = await sh("osascript", ["-e", script], { timeout: SH_MS.medium });
  if (!r.ok || !r.stdout) return null;
  const parts = r.stdout.split("\t");
  const role = (parts[1] || "").toLowerCase();
  const password = role.includes("secure") || role.includes("password");
  return {
    name: parts[0] || "",
    role: parts[1] || "",
    value: password ? "" : (parts[2] || "").slice(0, IO.a11yValue),
    selection: "",
    password_field: password,
  };
}

export async function getSelectionText() {
  return "";
}

export async function listWindows() {
  const script = [
    'tell application "System Events"',
    "set out to {}",
    "repeat with p in (every process whose background only is false)",
    "try",
    "set appName to name of p",
    "repeat with w in (every window of p)",
    "try",
    "set end of out to (appName & character id 9 & (name of w as text))",
    "end try",
    "end repeat",
    "end try",
    "end repeat",
    'set AppleScript\'s text item delimiters to character id 10',
    "return out as text",
    "end tell",
  ].join("\n");
  const r = await sh("osascript", ["-e", script], { timeout: SH_MS.focus });
  if (!r.ok || !r.stdout) return [];
  return packWindows(
    r.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [app = "", title = ""] = line.split("\t");
        return { app, title, pid: null };
      }),
  );
}

export async function listOpenFiles(_pid) {
  return [];
}

/** ms since last HID input (IOHIDSystem HIDIdleTime, nanoseconds). */
export async function getIdleMs() {
  const r = await sh("ioreg", ["-c", "IOHIDSystem", "-d", "4"], {
    timeout: SH_MS.medium,
  });
  if (!r.ok) return null;
  const m = r.stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!m) return null;
  const ns = Number(m[1]);
  if (!Number.isFinite(ns)) return null;
  return Math.round(ns / 1e6);
}
