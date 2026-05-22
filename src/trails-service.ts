import express, { type Request, type Response, type Express } from "express";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pinoHttp } from "pino-http";
import type { AppLogger } from "./logger.js";
import { silentLogger } from "./logger.js";

// Standalone map service for trail-route drafts — a separate Express app on its
// own loopback port (see src/trails-main.ts), independent of the MCP server in
// src/server.ts. It does two things:
//   1. serves the interactive route-preview HTML written by walk_route, and
//   2. proxies OS raster tiles with the OS Data Hub key injected server-side,
//      so the key never reaches the browser.
// Kept side-effect-free (no timers, no listen) so it can be exercised by an
// ephemeral listener in tests; the TTL sweep and listen live in trails-main.ts.

// Same strict id format save_route validates against (walk-route.ts deriveId
// emits 16 hex chars). Reused here so a mistyped or hostile id is a 404, never
// a path-traversal vector — the filesystem path is built only from a matched id.
const DRAFT_ID_RE = /^[0-9a-f]{16}$/;

// The OS layer name embedded in route.py's tile URLs (e.g. `Outdoor_27700`,
// `Leisure_27700`). A strict allowlist shape — letters then `_` then a 3-5 digit
// EPSG-style code — keeps the proxy from being coerced into other api.os.uk
// paths (SSRF / path escape); anything else is rejected before we build a URL.
const TILE_LAYER_RE = /^[A-Za-z]+_\d{3,5}$/;

// route.py renders its OS layer from this base; the proxy mirrors it exactly,
// appending `?key=<OS_API_KEY>` server-side. Keep in sync with route.py.
const OS_TILE_BASE = "https://api.os.uk/maps/raster/v1/zxy";

// Structural detector for a key-bearing OS tile URL in draft HTML: an api.os.uk
// reference followed (in the same URL) by a `key=` query param. Matching the
// shape rather than a specific key value catches a rotated/previous key, or any
// key when none is configured on this service — the requirement is that *no* OS
// key reaches the browser, not just the current one. `[^"'\s]*` stays within a
// single URL token (quote/whitespace delimited) so an unrelated later `key=`
// elsewhere in the page can't trip it.
const KEYFUL_OS_URL_RE = /api\.os\.uk[^"'\s]*[?&]key=/i;

export type TrailsServiceConfig = {
  /** Scratch dir holding one subdir per draft id (GPX + map HTML). */
  dataDir: string;
  /**
   * OS Data Hub API key. Injected into upstream tile requests only — never sent
   * to the client. When unset, the tile proxy returns 503 (drafts still serve).
   */
  osApiKey?: string;
  /**
   * Upstream fetcher, defaulting to the global `fetch` (Node 20+). Injected so
   * tests can stub the OS tile server without hitting the network — same
   * dependency-injection spirit as makeEngineRunner in walk-route.ts.
   */
  fetchFn?: typeof fetch;
  /**
   * Application logger. Defaults to a silent pino instance — production code
   * passes the rotating-file logger from createAppLogger.
   */
  logger?: AppLogger;
};

export function createTrailsService(config: TrailsServiceConfig): Express {
  const { dataDir, osApiKey } = config;
  const fetchFn = config.fetchFn ?? fetch;
  const logger = config.logger ?? silentLogger();

  const app = express();

  // One JSON line per HTTP request. Mirrors src/server.ts: log the path only
  // (never the query string — defence in depth, even though tile/draft URLs
  // carry no secrets) so the OS key can never reach a log line via the request.
  app.use(
    pinoHttp({
      logger,
      customSuccessMessage: () => "http request",
      customErrorMessage: () => "http request errored",
      serializers: {
        req(req: Request & { id?: string | number }) {
          const rawUrl = typeof req.url === "string" ? req.url : "";
          const qIndex = rawUrl.indexOf("?");
          const pathOnly = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
          return {
            id: req.id,
            method: req.method,
            path: pathOnly,
            remoteAddress: req.ip,
          };
        },
        res(res) {
          return { statusCode: res.statusCode };
        },
      },
    }),
  );

  // Liveness probe for the tunnel's readiness check. Does not touch the disk.
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Tile proxy. Express 5 (path-to-regexp v8) handles `:param.ext` awkwardly, so
  // match with an explicit RegExp and read the captured groups by index off
  // req.params. Order matters: register this before `/:id` so a `/tiles/...`
  // request can never be misread as a draft id.
  app.get(/^\/tiles\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.png$/, async (req, res) => {
    const params = req.params as Record<string, string>;
    const layer = params[0] ?? "";
    const z = params[1] ?? "";
    const x = params[2] ?? "";
    const y = params[3] ?? "";

    // Reject anything outside the OS layer shape before composing a URL — this
    // is the SSRF / path-escape guard. A generic 400 reveals nothing useful.
    if (!TILE_LAYER_RE.test(layer)) {
      res.status(400).json({ error: "bad request" });
      return;
    }

    // No key configured ⇒ the proxy cannot serve OS tiles. 503 (not 500) so the
    // caller can distinguish "not provisioned" from "broken".
    if (!osApiKey) {
      res.status(503).json({ error: "tile proxy unavailable" });
      return;
    }

    const upstreamUrl = `${OS_TILE_BASE}/${layer}/${z}/${x}/${y}.png?key=${encodeURIComponent(
      osApiKey,
    )}`;

    try {
      const upstream = await fetchFn(upstreamUrl);
      if (!upstream.ok) {
        // Never echo the upstream URL, key, or error body. Pass a 404 through
        // (a missing tile is a missing tile); collapse everything else to 502.
        const status = upstream.status === 404 ? 404 : 502;
        // Drain the upstream body so the connection can be released; we do not
        // forward it.
        await upstream.arrayBuffer().catch(() => {});
        res.status(status).json({ error: "tile unavailable" });
        return;
      }
      const contentType = upstream.headers.get("content-type") ?? "image/png";
      const body = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", contentType);
      // Tiles are immutable for a given z/x/y; let the browser cache for a day.
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(body);
    } catch (err) {
      // A transport failure must not leak the upstream URL (which carries the
      // key) — log a key-free message and return a generic 502.
      logger.warn(
        { event: "tile_proxy_error", layer, err_message: (err as Error).message },
        "tile proxy upstream failed",
      );
      res.status(502).json({ error: "tile unavailable" });
    }
  });

  // Serve a draft's interactive map HTML by id. Strict id validation: a
  // mismatch is a 404 (don't reveal the expected format, don't 400) so the
  // service gives a uniform "no such draft" response to any malformed or
  // unknown id. The filesystem path is built only from the validated id.
  app.get("/:id", (req, res) => {
    const id = String(req.params.id ?? "").toLowerCase();
    if (!DRAFT_ID_RE.test(id)) {
      res.status(404).json({ error: "not found" });
      return;
    }

    const draftDir = path.join(dataDir, id);
    if (!existsSync(draftDir)) {
      res.status(404).json({ error: "not found" });
      return;
    }

    // The engine names the map HTML after the route (e.g. `<name>.html`), not a
    // fixed `map.html`, so find the single `.html` file in the draft dir —
    // exactly how runSaveRoute finds the `.gpx`.
    let htmlFile: string | undefined;
    try {
      htmlFile = readdirSync(draftDir).find((f) => f.toLowerCase().endsWith(".html"));
    } catch {
      htmlFile = undefined;
    }
    if (!htmlFile) {
      res.status(404).json({ error: "not found" });
      return;
    }

    // Absolute, validated path — id matched DRAFT_ID_RE and htmlFile is a real
    // dirent name from the draft dir, so neither can escape dataDir.
    const htmlPath = path.join(draftDir, htmlFile);

    let html: string;
    try {
      html = readFileSync(htmlPath, "utf8");
    } catch {
      res.status(404).json({ error: "not found" });
      return;
    }

    // Fail closed on a key-ful draft. Until route.py emits /tiles-relative URLs
    // (#33), walk_route can fall back to a standalone render that embeds an OS
    // key directly in the HTML — serving that verbatim would leak a server-side
    // key to the browser, which the issue forbids absolutely. Refuse on either
    // signal: the exact configured key, or — structurally — any key-bearing
    // api.os.uk URL (which also catches a rotated/previous key, or any key when
    // none is configured here). Log a key-free warning so the misconfiguration
    // is visible.
    if ((osApiKey && html.includes(osApiKey)) || KEYFUL_OS_URL_RE.test(html)) {
      logger.warn(
        { event: "keyful_draft_refused", id },
        "refused to serve a draft whose HTML embeds an OS key",
      );
      res.status(500).json({ error: "draft unavailable" });
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  });

  return app;
}

/**
 * Most-recent mtime among a draft dir and its direct contents, in ms.
 *
 * Aging from the directory mtime alone is wrong: walk_route reuses a
 * deterministic draft dir keyed by route name, and the engine *overwrites* the
 * same `.gpx`/`.html` files on a rerun. Overwriting a file bumps the file's
 * mtime, not the parent directory's (a dir's mtime only moves when entries are
 * added/removed/renamed), so an actively-regenerated draft would keep its
 * original dir mtime and could be swept while still in use. Taking the newest
 * mtime across the dir and its files reflects real activity in either case.
 */
function draftLastTouchedMs(dir: string): number {
  let newest = statSync(dir).mtimeMs;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return newest;
  }
  for (const name of names) {
    try {
      const m = statSync(path.join(dir, name)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      // A file that vanished between readdir and stat is not our problem.
    }
  }
  return newest;
}

/**
 * Remove draft subdirs whose newest contained file (or the dir itself) is older
 * than `ttlMs` from `dataDir`. Exported and pure (clock injectable via `now`) so
 * it is unit-testable without waiting on a timer; trails-main.ts schedules it on
 * an interval. Only direct children of `dataDir` whose name matches the draft-id
 * shape are considered, so a stray file or unrelated dir is left alone.
 */
export function sweepDrafts(dataDir: string, ttlMs: number, now: number = Date.now()): number {
  if (!existsSync(dataDir)) return 0;

  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return 0;
  }

  for (const name of entries) {
    if (!DRAFT_ID_RE.test(name)) continue;
    const dir = path.join(dataDir, name);
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;
      if (now - draftLastTouchedMs(dir) > ttlMs) {
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // A dir that vanished or can't be stat'd between readdir and stat is not
      // our problem — skip it.
    }
  }

  return removed;
}
