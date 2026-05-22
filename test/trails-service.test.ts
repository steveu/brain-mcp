import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTrailsService, sweepDrafts } from "../src/trails-service.js";

// A valid draft id is 16 hex chars (walk-route.ts deriveId / save_route regex).
const VALID_ID = "0123456789abcdef";

function startEphemeral(app: ReturnType<typeof createTrailsService>): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

/**
 * Consume a fetch response fully so the underlying socket can be released
 * before tearing the server down — see test/server.test.ts for why.
 */
async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* response may already be aborted */
  }
}

describe("createTrailsService — draft HTML", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "trails-data-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("serves the draft's .html for a valid id", async () => {
    const draftDir = path.join(dataDir, VALID_ID);
    mkdirSync(draftDir, { recursive: true });
    const html = "<html><body>route preview</body></html>";
    // The engine names the file after the route, not map.html — the service
    // must find whatever .html is in the dir.
    writeFileSync(path.join(draftDir, "My Walk.html"), html, "utf8");

    const app = createTrailsService({ dataDir });
    const handle = await startEphemeral(app);

    const res = await fetch(`${handle.url}/${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("route preview");

    await handle.close();
  });

  it("returns 404 for an unknown but valid-format id", async () => {
    const app = createTrailsService({ dataDir });
    const handle = await startEphemeral(app);

    const res = await fetch(`${handle.url}/${VALID_ID}`);
    expect(res.status).toBe(404);
    await drain(res);

    await handle.close();
  });

  it("returns 404 for an invalid id format (no format disclosure, not 400)", async () => {
    const app = createTrailsService({ dataDir });
    const handle = await startEphemeral(app);

    const res = await fetch(`${handle.url}/not-a-valid-id`);
    expect(res.status).toBe(404);
    await drain(res);

    await handle.close();
  });

  it("returns 404 when the draft dir exists but has no .html", async () => {
    const draftDir = path.join(dataDir, VALID_ID);
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(path.join(draftDir, "My Walk.gpx"), "<gpx/>", "utf8");

    const app = createTrailsService({ dataDir });
    const handle = await startEphemeral(app);

    const res = await fetch(`${handle.url}/${VALID_ID}`);
    expect(res.status).toBe(404);
    await drain(res);

    await handle.close();
  });
});

describe("createTrailsService — tile proxy", () => {
  let dataDir: string;
  const KEY = "super-secret-os-key-DO-NOT-LEAK";

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "trails-tiles-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("injects the key into the upstream request and streams the bytes back, never leaking the key", async () => {
    const tileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
    let seenUrl = "";
    const fetchFn = (async (input: RequestInfo | URL) => {
      seenUrl = String(input);
      return new Response(tileBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch;

    const app = createTrailsService({ dataDir, osApiKey: KEY, fetchFn });
    const handle = await startEphemeral(app);

    const res = await fetch(`${handle.url}/tiles/Outdoor_27700/12/2045/1362.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("max-age");

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(tileBytes)).toBe(true);

    // The stub saw the key injected server-side.
    expect(seenUrl).toContain("api.os.uk");
    expect(seenUrl).toContain("/Outdoor_27700/12/2045/1362.png");
    expect(seenUrl).toContain("key=");
    expect(seenUrl).toContain(encodeURIComponent(KEY));

    // The key must not appear in any client-visible response header or body.
    const headerDump = JSON.stringify([...res.headers.entries()]);
    expect(headerDump).not.toContain(KEY);
    expect(bytes.toString("utf8")).not.toContain(KEY);

    await handle.close();
  });

  it("rejects an invalid layer with 400 before contacting upstream", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response(Buffer.from([0]), { status: 200 });
    }) as typeof fetch;

    const app = createTrailsService({ dataDir, osApiKey: KEY, fetchFn });
    const handle = await startEphemeral(app);

    // `..` / a path-escape attempt does not match the RegExp route at all (404),
    // but a wrong-shaped layer that *does* match the route segment is a 400.
    const res = await fetch(`${handle.url}/tiles/notalayer/12/2045/1362.png`);
    expect(res.status).toBe(400);
    expect(called).toBe(false);
    await drain(res);

    await handle.close();
  });

  it("returns 503 when no OS key is configured", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response(Buffer.from([0]), { status: 200 });
    }) as typeof fetch;

    const app = createTrailsService({ dataDir, fetchFn });
    const handle = await startEphemeral(app);

    const res = await fetch(`${handle.url}/tiles/Outdoor_27700/12/2045/1362.png`);
    expect(res.status).toBe(503);
    expect(called).toBe(false);
    await drain(res);

    await handle.close();
  });

  it("collapses an upstream error to a generic status with no key or URL leak", async () => {
    const fetchFn = (async () =>
      new Response("upstream said: bad key at https://api.os.uk/...?key=LEAK", {
        status: 403,
      })) as typeof fetch;

    const app = createTrailsService({ dataDir, osApiKey: KEY, fetchFn });
    const handle = await startEphemeral(app);

    const res = await fetch(`${handle.url}/tiles/Outdoor_27700/12/2045/1362.png`);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain(KEY);
    expect(body).not.toContain("api.os.uk");

    await handle.close();
  });

  it("passes a 404 from upstream through as 404", async () => {
    const fetchFn = (async () =>
      new Response("not found", { status: 404 })) as typeof fetch;

    const app = createTrailsService({ dataDir, osApiKey: KEY, fetchFn });
    const handle = await startEphemeral(app);

    const res = await fetch(`${handle.url}/tiles/Outdoor_27700/0/0/0.png`);
    expect(res.status).toBe(404);
    await drain(res);

    await handle.close();
  });
});

describe("sweepDrafts", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "trails-sweep-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("removes a stale draft dir and keeps a fresh one", () => {
    const oldId = "aaaaaaaaaaaaaaaa";
    const freshId = "bbbbbbbbbbbbbbbb";
    const ttlMs = 24 * 60 * 60 * 1000; // 1 day

    const oldDir = path.join(dataDir, oldId);
    const freshDir = path.join(dataDir, freshId);
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(freshDir, { recursive: true });
    const oldHtml = path.join(oldDir, "x.html");
    writeFileSync(oldHtml, "old", "utf8");
    writeFileSync(path.join(freshDir, "x.html"), "fresh", "utf8");

    // Backdate both the old dir AND its contents well past the TTL — the sweep
    // ages from the newest contained file, so a stale-but-fresh-file draft must
    // survive (see the regeneration test below).
    const now = Date.now();
    const old = new Date(now - 2 * ttlMs);
    utimesSync(oldHtml, old, old);
    utimesSync(oldDir, old, old);

    const removed = sweepDrafts(dataDir, ttlMs, now);
    expect(removed).toBe(1);

    // Re-running finds nothing further to remove.
    expect(sweepDrafts(dataDir, ttlMs, now)).toBe(0);
  });

  it("keeps a draft whose dir mtime is stale but whose files were just rewritten", () => {
    // walk_route reuses a deterministic draft dir and the engine overwrites the
    // same files in place — which bumps file mtimes but not the dir mtime. The
    // sweep must not reap a draft that was just regenerated.
    const id = "cccccccccccccccc";
    const ttlMs = 24 * 60 * 60 * 1000; // 1 day
    const dir = path.join(dataDir, id);
    mkdirSync(dir, { recursive: true });
    const html = path.join(dir, "My Walk.html");
    writeFileSync(html, "regenerated", "utf8");

    const now = Date.now();
    // Dir mtime is ancient; the file is current (just rewritten).
    const ancient = new Date(now - 5 * ttlMs);
    utimesSync(dir, ancient, ancient);
    const fresh = new Date(now - 60 * 1000); // a minute ago
    utimesSync(html, fresh, fresh);

    expect(sweepDrafts(dataDir, ttlMs, now)).toBe(0);
  });

  it("ignores entries that do not match the draft-id shape", () => {
    const strayFile = path.join(dataDir, "README.txt");
    const strayDir = path.join(dataDir, "not-a-draft");
    writeFileSync(strayFile, "keep me", "utf8");
    mkdirSync(strayDir, { recursive: true });

    const now = Date.now();
    const old = new Date(now - 10 * 24 * 60 * 60 * 1000);
    utimesSync(strayFile, old, old);
    utimesSync(strayDir, old, old);

    const removed = sweepDrafts(dataDir, 1, now);
    expect(removed).toBe(0);
  });

  it("returns 0 when the data dir does not exist", () => {
    expect(sweepDrafts(path.join(dataDir, "missing"), 1)).toBe(0);
  });
});
