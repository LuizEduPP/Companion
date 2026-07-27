import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { extname, join, normalize } from "node:path";
import { config } from "./lib/config.mjs";
import {
  brainStatus,
  enqueueNudge,
  getUiState,
  noteActivity,
  startBrain,
} from "./lib/brain.mjs";

const HOT = config.hotReload;

/** Bumped when public/ changes so the orb page can location.reload(). */
let reloadToken = Date.now();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function serveStatic(res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  rel = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = join(config.publicDir, rel);
  if (!file.startsWith(config.publicDir) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404);
    return res.end();
  }
  const headers = {
    "Content-Type": MIME[extname(file)] || "application/octet-stream",
  };
  if (HOT) {
    headers["Cache-Control"] = "no-store";
  }
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/api/health") {
      return json(res, 200, {
        ok: true,
        service: "companion",
        model: config.chatModel,
        hot: HOT,
        reload: reloadToken,
        brain: brainStatus(),
      });
    }

    if (req.method === "GET" && pathname === "/api/pc/ui") {
      return json(res, 200, getUiState());
    }

    if (req.method === "POST" && pathname === "/api/pc/activity") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const out = noteActivity(body);
      return json(res, 200, { ok: true, ...out });
    }

    if (req.method === "POST" && pathname === "/api/pc/nudge") {
      enqueueNudge();
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET") {
      return serveStatic(res, pathname);
    }

    res.writeHead(404);
    return res.end();
  } catch (err) {
    console.error("[companion]", err);
    return json(res, 500, { error: err.message ?? String(err) });
  }
});

startBrain();

if (HOT && existsSync(config.publicDir)) {
  try {
    watch(config.publicDir, { recursive: true }, () => {
      reloadToken = Date.now();
    });
    console.log("companion hot: watching public/ for orb reload");
  } catch (err) {
    console.error("companion hot: public watch failed", err.message);
  }
}

server.listen(config.port, config.host, () => {
  console.log(`companion ${config.host}:${config.port}${HOT ? " · hot" : ""}`);
});
