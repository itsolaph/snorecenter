/**
 * SnoreCenter HTTP server (pure `node:http`, zero runtime dependencies).
 * Designed for Fly.io Sprites sleep-to-zero / wake-on-HTTP on port 8080.
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeAudioBinaries } from "./dsp.mjs";
import {
  initDb,
  listSessions,
  getSession,
  getSeasonStats,
  updateSessionCheckpoint,
} from "./db.mjs";
import {
  discoverConnectors,
  listCheckpoints,
  createCheckpoint,
  EVENT_LABELS,
} from "./connectors.mjs";
import {
  seedInitialTapesIfEmpty,
  processAudioTape,
  reclassifyEvent,
  archiveSessionCard,
  renderBreakfastBoxScoreHtml,
} from "./pipeline.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const SAMPLES_DIR = path.join(ROOT_DIR, "samples");

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ico": "image/x-icon",
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(html);
}

async function readBody(req, limit = MAX_UPLOAD_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const err = new Error("Payload too large");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serveFileWithRange(req, res, filePath) {
  const stat = await fsp.stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || "application/octet-stream";
  const range = req.headers.range;

  const baseHeaders = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": ext === ".woff2" || ext === ".jpg" ? "public, max-age=86400" : "no-cache",
  };

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(stat.size - 1, parseInt(match[2], 10)) : stat.size - 1;
      if (start >= stat.size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, { ...baseHeaders, "Content-Length": stat.size });
  fs.createReadStream(filePath).pipe(res);
}

function safeResolve(baseDir, relPath) {
  const cleaned = decodeURIComponent(relPath).replace(/^\/+/, "");
  const resolved = path.resolve(baseDir, cleaned);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep) && resolved !== path.resolve(baseDir)) {
    return null;
  }
  return resolved;
}

function renderConnectedProofHtml(proof) {
  const rows = Object.values(proof.connectors)
    .sort((a, b) => Number(Boolean(b.connected)) - Number(Boolean(a.connected)))
    .map(
      (c) => `<tr>
        <td><strong>${c.name}</strong></td>
        <td>${c.connected ? "Connected via Sprite Gateway" : c.mode}</td>
        <td>${c.gatewayBaseUrl ? `<code>${c.gatewayBaseUrl}</code>` : "Local baseline fallback"}</td>
        <td>${c.role}</td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SnoreCenter — Zero-Key Connector Proof</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main class="shell" style="padding-block: var(--space-xl);">
    <p><a href="/">Back to Morning Broadcast</a></p>
    <h1 class="connected-title">Zero-key Sprites Connector proof</h1>
    <p class="lede">Live inspection of <code>GET /v1/gateway/list</code> and environment secret scan inside this runtime.</p>
    <div class="stat-strip">
      <div class="stat-cell"><div class="fig">${proof.envAudit.rawApiKeysInEnv}</div><div class="stat-label">Raw API keys in Sprite env</div></div>
      <div class="stat-cell"><div class="fig">${proof.connectedCount}/${proof.totalCatalog}</div><div class="stat-label">Active Sprite Connectors</div></div>
      <div class="stat-cell"><div class="fig">${proof.insideSprite ? "SPRITE" : "LOCAL"}</div><div class="stat-label">Runtime environment</div></div>
      <div class="stat-cell"><div class="fig">${proof.binaries.ffmpeg.available ? "FFMPEG" : "PCM"}</div><div class="stat-label">Audio ingest engine</div></div>
    </div>
    <div tabindex="0" role="region" aria-labelledby="conn-cap" class="table-wrapper" style="margin-top: var(--space-xl);">
      <table class="film-table conn-table">
        <caption id="conn-cap" class="sr-only">Sprites Connector status</caption>
        <thead><tr><th>Connector</th><th>Status</th><th>Gateway base</th><th>Role</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="caption" style="margin-top: var(--space-md);">JSON view available at <a href="/connected?format=json">/connected?format=json</a>.</p>
  </main>
</body>
</html>`;
}

export async function createAppServer(options = {}) {
  const dataDir = options.dataDir || process.env.SNORECENTER_DATA_DIR || path.join(ROOT_DIR, "data");
  const audioDir = path.join(dataDir, "audio");
  const exportsDir = path.join(dataDir, "exports");
  const checkpointsDir = path.join(dataDir, "checkpoints");
  const dbPath = options.dbPath || process.env.SNORECENTER_DB || path.join(dataDir, "snorecenter.sqlite");

  await fsp.mkdir(audioDir, { recursive: true });
  await fsp.mkdir(exportsDir, { recursive: true });
  await fsp.mkdir(checkpointsDir, { recursive: true });

  const db = initDb(dbPath);
  const binaries = await probeAudioBinaries();
  await seedInitialTapesIfEmpty(db, SAMPLES_DIR, audioDir);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = url.pathname;
      const method = req.method || "GET";

      // Health endpoint
      if (method === "GET" && pathname === "/healthz") {
        const discovery = await discoverConnectors();
        return sendJson(res, 200, {
          ok: true,
          service: "snorecenter",
          uptimeSec: Math.round(process.uptime()),
          insideSprite: discovery.insideSprite,
          connectedConnectors: discovery.connectedCount,
          rawApiKeysInEnv: discovery.envAudit.rawApiKeysInEnv,
          binaries,
        });
      }

      // Live Connector & zero-key proof endpoint
      if (method === "GET" && pathname === "/connected") {
        const discovery = await discoverConnectors(url.searchParams.get("refresh") === "1");
        const checkpoints = await listCheckpoints(checkpointsDir);
        const proof = {
          ...discovery,
          binaries,
          checkpointsCount: checkpoints.length,
          checkpoints,
        };
        const wantsJson =
          url.searchParams.get("format") === "json" ||
          (req.headers.accept || "").includes("application/json");
        if (wantsJson) return sendJson(res, 200, proof);
        return sendHtml(res, 200, renderConnectedProofHtml(proof));
      }

      // Main app state
      if (method === "GET" && pathname === "/api/state") {
        const sessions = listSessions(db, 20);
        const requestedId = url.searchParams.get("session");
        const activeId = requestedId || sessions[0]?.id || null;
        const activeSession = activeId ? getSession(db, activeId) : null;
        const [discovery, checkpoints] = await Promise.all([
          discoverConnectors(),
          listCheckpoints(checkpointsDir),
        ]);
        const season = getSeasonStats(db);

        return sendJson(res, 200, {
          activeSession,
          sessions,
          season,
          eventLabels: EVENT_LABELS,
          connectors: discovery,
          binaries,
          checkpoints,
        });
      }

      // Single session fetch
      const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
      if (method === "GET" && sessionMatch) {
        const session = getSession(db, decodeURIComponent(sessionMatch[1]));
        if (!session) return sendJson(res, 404, { error: "Session not found" });
        return sendJson(res, 200, session);
      }

      // Standalone Breakfast Box Score HTML card
      const cardMatch = /^\/api\/sessions\/([^/]+)\/card$/.exec(pathname);
      if (method === "GET" && cardMatch) {
        const session = getSession(db, decodeURIComponent(cardMatch[1]));
        if (!session) return sendJson(res, 404, { error: "Session not found" });
        return sendHtml(res, 200, renderBreakfastBoxScoreHtml(session));
      }

      // Run real sample tape
      if (method === "POST" && pathname === "/api/analyze/sample") {
        const bodyBuf = await readBody(req, 1024 * 64);
        let body = {};
        if (bodyBuf.length > 0) {
          try {
            body = JSON.parse(bodyBuf.toString("utf8"));
          } catch {
            body = {};
          }
        }
        const which = body.sample === "tuesday" ? "tuesday-baseline.wav" : "last-night-highlight.wav";
        const samplePath = path.join(SAMPLES_DIR, which);
        if (!fs.existsSync(samplePath)) {
          return sendJson(res, 404, { error: "Sample WAV missing. Run npm run generate-samples." });
        }
        const wavBuf = await fsp.readFile(samplePath);
        const session = await processAudioTape(db, wavBuf, {
          title: which === "tuesday-baseline.wav" ? "Tuesday Tape Replay" : "Last Night's Fresh Cut",
          nightDate: new Date().toISOString().slice(0, 10),
          mode: "overnight",
          source: "sample-rerun",
          filename: which,
          audioDir,
        });
        return sendJson(res, 201, { session, season: getSeasonStats(db), sessions: listSessions(db, 20) });
      }

      // Upload live mic recording or WAV/audio file
      if (method === "POST" && pathname === "/api/analyze/upload") {
        const ctype = (req.headers["content-type"] || "").toLowerCase();
        const bodyBuf = await readBody(req, MAX_UPLOAD_BYTES);
        let audioBuf = bodyBuf;
        let filename = String(req.headers["x-filename"] || "live-room.wav");
        let title = String(req.headers["x-session-title"] || "Live Room Check");
        let mode = req.headers["x-recording-mode"] ? String(req.headers["x-recording-mode"]) : undefined;

        if (ctype.includes("application/json")) {
          const parsed = JSON.parse(bodyBuf.toString("utf8"));
          if (!parsed.audioBase64) {
            return sendJson(res, 400, { error: "Missing audioBase64 payload" });
          }
          audioBuf = Buffer.from(parsed.audioBase64, "base64");
          filename = parsed.filename || filename;
          title = parsed.title || title;
          mode = parsed.mode || mode;
        }

        if (!audioBuf || audioBuf.length < 44) {
          return sendJson(res, 400, { error: "Audio payload is empty or too short" });
        }

        const session = await processAudioTape(db, audioBuf, {
          title: String(title).slice(0, 80),
          nightDate: new Date().toISOString().slice(0, 10),
          mode,
          source: mode === "live" ? "live-mic" : "audio-upload",
          filename,
          audioDir,
        });
        return sendJson(res, 201, { session, season: getSeasonStats(db), sessions: listSessions(db, 20) });
      }

      // Human "You call it" override
      const recallMatch = /^\/api\/events\/([^/]+)\/recall$/.exec(pathname);
      if (method === "POST" && recallMatch) {
        const bodyBuf = await readBody(req, 1024 * 32);
        const body = JSON.parse(bodyBuf.toString("utf8") || "{}");
        if (!body.label || !EVENT_LABELS[body.label]) {
          return sendJson(res, 400, { error: "Invalid event label" });
        }
        const session = await reclassifyEvent(
          db,
          decodeURIComponent(recallMatch[1]),
          body.label,
          body.note || ""
        );
        if (!session) return sendJson(res, 404, { error: "Event not found" });
        return sendJson(res, 200, { session, season: getSeasonStats(db) });
      }

      // Archive Breakfast Box Score to Box Connector
      const boxMatch = /^\/api\/sessions\/([^/]+)\/archive-box$/.exec(pathname);
      if (method === "POST" && boxMatch) {
        const result = await archiveSessionCard(
          db,
          decodeURIComponent(boxMatch[1]),
          exportsDir
        );
        if (!result) return sendJson(res, 404, { error: "Session not found" });
        return sendJson(res, 200, result);
      }

      // Sprite checkpoints
      if (method === "GET" && pathname === "/api/checkpoints") {
        const checkpoints = await listCheckpoints(checkpointsDir);
        return sendJson(res, 200, { checkpoints });
      }

      if (method === "POST" && pathname === "/api/checkpoints") {
        const bodyBuf = await readBody(req, 1024 * 16);
        const body = bodyBuf.length ? JSON.parse(bodyBuf.toString("utf8")) : {};
        const cp = await createCheckpoint(body.comment || "Morning edition snapshot", dbPath, checkpointsDir);
        if (body.sessionId) {
          updateSessionCheckpoint(db, body.sessionId, cp.id);
        }
        const checkpoints = await listCheckpoints(checkpointsDir);
        return sendJson(res, 201, { checkpoint: cp, checkpoints });
      }

      // Audio streaming with Range support
      if (method === "GET" && pathname.startsWith("/audio/")) {
        const filePath = safeResolve(audioDir, pathname.slice("/audio/".length));
        if (!filePath || !fs.existsSync(filePath)) {
          return sendJson(res, 404, { error: "Audio clip not found" });
        }
        return await serveFileWithRange(req, res, filePath);
      }

      // Static frontend files
      if (method === "GET") {
        if (pathname === "/favicon.ico") {
          const icoSvg = path.join(PUBLIC_DIR, "favicon.svg");
          if (fs.existsSync(icoSvg)) return await serveFileWithRange(req, res, icoSvg);
        }
        const rel = pathname === "/" ? "index.html" : pathname;
        const filePath = safeResolve(PUBLIC_DIR, rel);
        if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          return await serveFileWithRange(req, res, filePath);
        }
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      const status = err.statusCode || 500;
      sendJson(res, status, { error: err.message || "Internal server error" });
    }
  });

  return {
    server,
    db,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          try {
            db.close();
          } catch {
            // ignore
          }
          resolve();
        });
      }),
  };
}

// Direct CLI start
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || "0.0.0.0";
  const port = Number(process.env.PORT || 8080);
  const { server } = await createAppServer();
  server.listen(port, host, () => {
    console.log(`SnoreCenter listening on http://${host}:${port}`);
  });
}
