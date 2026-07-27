import { sh, packFocus, LIMITS } from "./util.mjs";

export async function getFocus() {
  const ps = [
    "$sig = @'",
    "[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
    "[DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);",
    "[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);",
    "'@",
    "Add-Type -MemberDefinition $sig -Name U -Namespace W -ErrorAction SilentlyContinue | Out-Null",
    "$h = [W.U]::GetForegroundWindow()",
    "$sb = New-Object System.Text.StringBuilder 512",
    "[void][W.U]::GetWindowText($h, $sb, $sb.Capacity)",
    "$pidOut = 0",
    "[void][W.U]::GetWindowThreadProcessId($h, [ref]$pidOut)",
    "$proc = Get-Process -Id $pidOut -ErrorAction SilentlyContinue",
    "$name = if ($proc) { $proc.ProcessName } else { '' }",
    "$path = ''",
    "try { if ($proc -and $proc.Path) { $path = $proc.Path } } catch {}",
    "Write-Output ($name + [char]9 + $sb.ToString() + [char]9 + $pidOut + [char]9 + $path)",
  ].join("; ");
  const r = await sh("powershell", ["-NoProfile", "-Command", ps], {
    timeout: 10000,
  });
  if (!r.ok) return null;
  const line = r.stdout.split(/\r?\n/).filter(Boolean).pop() || "";
  const parts = line.split("\t");
  const app = (parts[0] || "").trim();
  const title = (parts[1] || "").trim() || app;
  const pid = Number(parts[2]) || null;
  return packFocus({ app, title, pid, desktopFile: (parts[3] || "").trim() });
}

export async function getClipboardText() {
  const r = await sh(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "try { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText() } catch { '' }",
    ],
    { timeout: 3000 },
  );
  return r.ok ? r.stdout.slice(0, LIMITS.clipboardRaw) : "";
}

export async function getA11yFocus() {
  const ps = `
Add-Type -AssemblyName UIAutomationClient -ErrorAction SilentlyContinue
Add-Type -AssemblyName UIAutomationTypes -ErrorAction SilentlyContinue
try {
  $auto = [System.Windows.Automation.AutomationElement]::FocusedElement
  if (-not $auto) { '' ; exit }
  $name = $auto.Current.Name
  $role = $auto.Current.ControlType.ProgrammaticName
  $password = $false
  try { $password = [bool]$auto.Current.IsPassword } catch {}
  $value = ''
  $selection = ''
  if (-not $password) {
    try {
      $vp = $auto.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if ($vp) { $value = $vp.Current.Value }
    } catch {}
    try {
      $tp = $auto.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      if ($tp) {
        if (-not $value) { $value = $tp.DocumentRange.GetText(${LIMITS.a11yValue}) }
        $sels = $tp.GetSelection()
        if ($sels -and $sels.Length -gt 0) {
          $selection = $sels[0].GetText(${LIMITS.a11ySelection})
        }
      }
    } catch {}
  }
  @{ name=$name; role=$role; value=$value; selection=$selection; password_field=$password } | ConvertTo-Json -Compress
} catch { '' }
`;
  const r = await sh("powershell", ["-NoProfile", "-Command", ps], {
    timeout: 4000,
  });
  if (!r.ok || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/** Selection ≈ clipboard on Windows when user copies; also from a11y.selection. */
export async function getSelectionText() {
  return "";
}

export async function listWindows() {
  return [];
}

export async function listOpenFiles(_pid) {
  return [];
}

/** ms since last keyboard/mouse input (GetLastInputInfo). */
export async function getIdleMs() {
  const ps = [
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class CompanionIdle {",
    "  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }",
    "  [DllImport(\"user32.dll\")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);",
    "  public static uint IdleMs() {",
    "    LASTINPUTINFO lii = new LASTINPUTINFO();",
    "    lii.cbSize = (uint)Marshal.SizeOf(lii);",
    "    if (!GetLastInputInfo(ref lii)) return 0;",
    "    return unchecked((uint)Environment.TickCount) - lii.dwTime;",
    "  }",
    "}",
    "'@ -ErrorAction SilentlyContinue | Out-Null",
    "[CompanionIdle]::IdleMs()",
  ].join("; ");
  const r = await sh("powershell", ["-NoProfile", "-Command", ps], {
    timeout: 4000,
  });
  if (!r.ok) return null;
  const n = Number(String(r.stdout).trim().split(/\r?\n/).pop());
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}
