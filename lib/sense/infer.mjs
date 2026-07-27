/** Structural inference from window title — no app-name catalog. */

export function inferKind(_app, title, url, file) {
  if (url) return "browser";
  if (file) return "editor";
  const t = String(title || "");
  // Absolute path in title → editor-like.
  if (/(\/[\w.+@\/\-]+|[A-Za-z]:\\[\w.\\\/\- ]+)/.test(t)) return "editor";
  return "other";
}

function normLabel(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\.desktop$/i, "");
}

/** Last title segment is often the app chrome ("— Konsole"), not a project. */
function looksLikeAppChrome(segment, app) {
  const seg = normLabel(segment);
  const a = normLabel(app);
  if (!seg) return true;
  if (a && (seg === a || seg.includes(a) || a.includes(seg))) return true;
  return false;
}

export function inferFromTitle(app, title) {
  const t = String(title || "");
  const a = String(app || "");
  const out = {
    url: null,
    file: null,
    file_name: null,
    project_guess: null,
    path_hint: null,
    file_hint: null,
    kind: "other",
    signals: [],
  };

  const urlMatch = t.match(/https?:\/\/[^\s)\]>"']+/i);
  if (urlMatch) {
    out.url = urlMatch[0].replace(/[.,;]+$/, "").slice(0, 500);
    out.signals.push("url_in_title");
  }

  const parts = t.split(/\s+[—–\-·|]\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    out.file_hint = parts[0].slice(0, 120);
    const last = parts[parts.length - 1];
    if (!looksLikeAppChrome(last, a)) {
      out.project_guess = last.slice(0, 80);
      out.signals.push("title_segments");
    } else if (parts.length >= 3) {
      const mid = parts[parts.length - 2];
      if (!looksLikeAppChrome(mid, a)) {
        out.project_guess = mid.slice(0, 80);
        out.signals.push("title_segments_mid");
      }
    }
  }

  const pathMatch = t.match(/(\/[\w.+@\/\-]+|[A-Za-z]:\\[\w.\\\/\- ]+)/);
  if (pathMatch) {
    out.path_hint = pathMatch[1].slice(0, 260);
    out.file = out.path_hint;
    out.file_name = out.path_hint.split(/[/\\]/).pop() || null;
    out.signals.push("path_in_title");
    const segs = out.path_hint.split(/[/\\]/).filter(Boolean);
    if (segs.length >= 2) {
      const folder = segs[segs.length - 2];
      if (!looksLikeAppChrome(folder, a)) {
        out.project_guess = folder.slice(0, 80);
      }
    }
  } else if (out.file_hint && /\.\w{1,12}$/.test(out.file_hint)) {
    out.file_name = out.file_hint;
    out.signals.push("filename_in_title");
  }

  if (a) out.signals.push(`app:${a}`);
  if (t) out.signals.push("has_title");
  out.kind = inferKind(a, t, out.url, out.file);
  return out;
}
