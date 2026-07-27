/** Structural signals from window title — url/path/segments only, no kind taxonomy. */
import { LIMITS } from "./util.mjs";

const PATH_IN_TITLE = /(\/[\w.+@\/\-]+|[A-Za-z]:\\[\w.\\\/\- ]+)/;
const URL_IN_TITLE = /https?:\/\/[^\s)\]>"']+/i;
const TITLE_SPLIT = /\s+[—–\-·|]\s+/;

export function inferFromTitle(app, title) {
  const t = String(title || "");
  const a = String(app || "");
  const out = {
    url: null,
    file: null,
    file_name: null,
    path_hint: null,
    file_hint: null,
    title_segments: [],
    signals: [],
  };

  const urlMatch = t.match(URL_IN_TITLE);
  if (urlMatch) {
    out.url = urlMatch[0].replace(/[.,;]+$/, "").slice(0, LIMITS.url);
    out.signals.push("url_in_title");
  }

  const parts = t.split(TITLE_SPLIT).map((s) => s.trim()).filter(Boolean);
  if (parts.length) {
    out.title_segments = parts.map((s) => s.slice(0, LIMITS.fileHint));
    out.signals.push("title_segments");
    if (parts.length >= 2) {
      out.file_hint = parts[0].slice(0, LIMITS.fileHint);
    }
  }

  const pathMatch = t.match(PATH_IN_TITLE);
  if (pathMatch) {
    out.path_hint = pathMatch[1].slice(0, LIMITS.path);
    out.file = out.path_hint;
    out.file_name = out.path_hint.split(/[/\\]/).pop() || null;
    out.signals.push("path_in_title");
  } else if (out.file_hint && /\.\w{1,12}$/.test(out.file_hint)) {
    out.file_name = out.file_hint;
    out.signals.push("filename_in_title");
  }

  if (a) out.signals.push(`app:${a}`);
  if (t) out.signals.push("has_title");
  return out;
}
