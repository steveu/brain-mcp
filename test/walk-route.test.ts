import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultTileBase,
  deriveId,
  findOutliers,
  makeEngineRunner,
  runSaveRoute,
  runWalkRoute,
  type EngineMetrics,
  type EngineParams,
  type EngineRunner,
} from "../src/tools/walk-route.js";

const CANNED: EngineMetrics = {
  name: "Sat Loop",
  profile: "hiking-beta",
  miles: 6.25,
  length_m: 10058,
  ascent_m: 320,
  trackpoints: 1200,
  retrace_pct: 12,
  car_m: 800,
  foot_m: 9000,
  other_m: 258,
  waypoints: [
    { label: "Catgill Farm", ll: [53.9742, -1.8942] },
    { label: null, ll: [53.98, -1.88] },
    { label: "Bolton Abbey", ll: [53.9836, -1.8889] },
  ],
  pins: [{ label: "The Strid", type: "Landmark", ll: [53.99, -1.9] }],
  gpx: "/scratch/Sat Loop.gpx",
  html: "/scratch/Sat Loop.html",
};

describe("runWalkRoute", () => {
  let dataDir: string;
  let captured: EngineParams | undefined;

  // A stub engine that does what route.py does to the filesystem (writes a GPX
  // into out-dir) and returns canned metrics — no python, no network.
  const stubEngine: EngineRunner = async (p) => {
    captured = p;
    mkdirSync(p.outDir, { recursive: true });
    writeFileSync(path.join(p.outDir, `${p.name}.gpx`), "<gpx/>", "utf8");
    return { ...CANNED, name: p.name };
  };

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "trails-data-"));
    captured = undefined;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns metrics text with the map URL and writes the draft under <dataDir>/<id>/", async () => {
    const text = await runWalkRoute(
      {
        runEngine: stubEngine,
        dataDir,
        routePy: "/skills/trails/route.py",
        trailsHost: "https://trails.example.org",
        idSalt: "s3cr3t",
      },
      { waypoints: "Catgill Farm|Bolton Abbey", name: "Sat Loop" },
    );

    const id = deriveId("Sat Loop", "s3cr3t");
    expect(text).toContain("Sat Loop — 6.25 mi · 320 m ascent · 12% retrace");
    expect(text).toContain("Roads with cars: 800 m");
    expect(text).toContain("Catgill Farm — 53.97420, -1.89420");
    expect(text).toContain("(unnamed coord) — 53.98000, -1.88000");
    expect(text).toContain("The Strid [Landmark]");
    expect(text).toContain(`Map: https://trails.example.org/${id}`);
    expect(text).toContain(`Draft id: ${id}`);

    // The engine was handed the id-scoped out-dir, and the draft GPX landed there.
    expect(captured?.outDir).toBe(path.join(dataDir, id));
    expect(existsSync(path.join(dataDir, id, "Sat Loop.gpx"))).toBe(true);
  });

  it("omits the map URL with a note when TRAILS_HOST is unset", async () => {
    const text = await runWalkRoute(
      { runEngine: stubEngine, dataDir, routePy: "/r.py" },
      { waypoints: "A|B", name: "No Host" },
    );
    expect(text).toContain("Map: URL unavailable (TRAILS_HOST not set on the server).");
    expect(text).not.toMatch(/Map: https?:\/\//);
  });

  it("trims a trailing slash on TRAILS_HOST when building the map URL", async () => {
    const text = await runWalkRoute(
      { runEngine: stubEngine, dataDir, routePy: "/r.py", trailsHost: "https://t.example/" },
      { waypoints: "A|B", name: "Slash" },
    );
    const id = deriveId("Slash");
    expect(text).toContain(`Map: https://t.example/${id}`);
  });

  it("derives the same id (and scratch dir) for the same name", async () => {
    await runWalkRoute(
      { runEngine: stubEngine, dataDir, routePy: "/r.py" },
      { waypoints: "A|B", name: "Stable" },
    );
    const first = captured?.outDir;
    await runWalkRoute(
      { runEngine: stubEngine, dataDir, routePy: "/r.py" },
      { waypoints: "A|B|C", name: "Stable" },
    );
    expect(captured?.outDir).toBe(first);
  });

  it("refreshes the draft dir mtime before the engine runs so a regeneration isn't swept", async () => {
    // First render to create the deterministic dir, then backdate it well into
    // the past — simulating a draft last touched beyond the sweep TTL.
    await runWalkRoute(
      { runEngine: stubEngine, dataDir, routePy: "/r.py" },
      { waypoints: "A|B", name: "Regen" },
    );
    const outDir = captured!.outDir;
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(outDir, ancient, ancient);

    // An engine that records the dir mtime *as the engine starts* (before it
    // writes any file) — that mtime must already be fresh, proving runWalkRoute
    // touched the dir before the slow render rather than relying on the engine's
    // file writes.
    let mtimeAtEngineStart = 0;
    const observingEngine: EngineRunner = async (p) => {
      mtimeAtEngineStart = statSync(p.outDir).mtimeMs;
      mkdirSync(p.outDir, { recursive: true });
      writeFileSync(path.join(p.outDir, `${p.name}.gpx`), "<gpx/>", "utf8");
      return { ...CANNED, name: p.name };
    };

    const before = Date.now();
    await runWalkRoute(
      { runEngine: observingEngine, dataDir, routePy: "/r.py" },
      { waypoints: "A|B|C", name: "Regen" },
    );

    // The dir was touched to ~now before the engine ran, not left ancient.
    expect(mtimeAtEngineStart).toBeGreaterThanOrEqual(before - 2000);
  });

  it("passes pins, profile and basemap through to the engine", async () => {
    await runWalkRoute(
      { runEngine: stubEngine, dataDir, routePy: "/r.py" },
      {
        waypoints: "A|B",
        name: "Through",
        pins: "Viewpoint::nice",
        profile: "trekking",
        basemap: "opentopo",
      },
    );
    expect(captured?.pins).toBe("Viewpoint::nice");
    expect(captured?.profile).toBe("trekking");
    expect(captured?.basemap).toBe("opentopo");
  });

  it("defaults the profile to hiking-beta", async () => {
    await runWalkRoute(
      { runEngine: stubEngine, dataDir, routePy: "/r.py" },
      { waypoints: "A|B", name: "Default Profile" },
    );
    expect(captured?.profile).toBe("hiking-beta");
  });

  it("surfaces an implausibly-geocoded waypoint instead of routing it silently", async () => {
    const farEngine: EngineRunner = async (p) => {
      mkdirSync(p.outDir, { recursive: true });
      return {
        ...CANNED,
        name: p.name,
        waypoints: [
          { label: "Catgill Farm", ll: [53.9742, -1.8942] },
          { label: "Bolton Abbey", ll: [53.9836, -1.8889] },
          { label: "Boston (wrong)", ll: [42.36, -71.06] },
        ],
      };
    };
    const text = await runWalkRoute(
      { runEngine: farEngine, dataDir, routePy: "/r.py" },
      { waypoints: "A|B|C", name: "Bad Geocode" },
    );
    expect(text).toContain("⚠ Possible bad geocode");
    expect(text).toContain("Boston (wrong)");
  });

  it("throws when the name is empty after cleaning", async () => {
    await expect(
      runWalkRoute(
        { runEngine: stubEngine, dataDir, routePy: "/r.py" },
        { waypoints: "A|B", name: "///" },
      ),
    ).rejects.toThrow(/name is empty after cleaning/);
  });
});

describe("deriveId", () => {
  it("is deterministic, 16 hex chars, and salt-sensitive", () => {
    expect(deriveId("Sat Loop")).toBe(deriveId("Sat Loop"));
    expect(deriveId("Sat Loop")).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveId("Sat Loop", "salt")).not.toBe(deriveId("Sat Loop"));
    expect(deriveId("Sat Loop")).not.toBe(deriveId("Sun Loop"));
  });
});

describe("findOutliers", () => {
  it("returns nothing for a tight cluster", () => {
    expect(findOutliers(CANNED.waypoints)).toEqual([]);
  });

  it("flags only the genuinely isolated point, not the good cluster", () => {
    // Two correct Yorkshire points and one wildly-wrong Boston/US result. A
    // centroid test would flag all three; nearest-neighbour flags only Boston.
    const out = findOutliers([
      { label: "Catgill", ll: [53.9742, -1.8942] },
      { label: "Bolton Abbey", ll: [53.9836, -1.8889] },
      { label: "Boston (wrong)", ll: [42.36, -71.06] },
    ]);
    expect(out.map((o) => o.label)).toEqual(["Boston (wrong)"]);
  });
});

describe("defaultTileBase", () => {
  let host: string | undefined;
  let tb: string | undefined;

  beforeEach(() => {
    host = process.env.TRAILS_HOST;
    tb = process.env.TRAILS_TILE_BASE;
  });

  afterEach(() => {
    if (host === undefined) delete process.env.TRAILS_HOST;
    else process.env.TRAILS_HOST = host;
    if (tb === undefined) delete process.env.TRAILS_TILE_BASE;
    else process.env.TRAILS_TILE_BASE = tb;
  });

  it("defaults to /tiles when TRAILS_HOST is set (service deployed)", () => {
    process.env.TRAILS_HOST = "https://trails.example.org";
    delete process.env.TRAILS_TILE_BASE;
    expect(defaultTileBase()).toBe("/tiles");
  });

  it("is undefined when TRAILS_HOST is unset (standalone render)", () => {
    delete process.env.TRAILS_HOST;
    delete process.env.TRAILS_TILE_BASE;
    expect(defaultTileBase()).toBeUndefined();
  });

  it("honours an explicit TRAILS_TILE_BASE override", () => {
    process.env.TRAILS_HOST = "https://trails.example.org";
    process.env.TRAILS_TILE_BASE = "/map-tiles";
    expect(defaultTileBase()).toBe("/map-tiles");
  });

  it("treats an empty TRAILS_TILE_BASE as force-disabled", () => {
    process.env.TRAILS_HOST = "https://trails.example.org";
    process.env.TRAILS_TILE_BASE = "";
    expect(defaultTileBase()).toBeUndefined();
  });
});

describe("makeEngineRunner", () => {
  const base: Omit<EngineParams, "tileBase"> = {
    routePy: "/skills/trails/route.py",
    waypoints: "A|B",
    name: "Run",
    outDir: "/scratch/abc",
    profile: "hiking-beta",
  };

  it("retries without --tile-base when the engine rejects the unknown flag", async () => {
    const calls: string[][] = [];
    const exec = async (_file: string, argv: string[]) => {
      calls.push(argv);
      if (argv.includes("--tile-base")) {
        const err = new Error("Command failed") as Error & { stderr: string };
        err.stderr =
          "usage: route.py ...\nroute.py: error: unrecognized arguments: --tile-base /tiles";
        throw err;
      }
      return { stdout: JSON.stringify(CANNED), stderr: "" };
    };
    const engine = makeEngineRunner(exec);
    const m = await engine({ ...base, tileBase: "/tiles" });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--tile-base");
    expect(calls[1]).not.toContain("--tile-base");
    expect(m.miles).toBe(6.25);
  });

  it("does not pass --tile-base when none is configured", async () => {
    const calls: string[][] = [];
    const exec = async (_file: string, argv: string[]) => {
      calls.push(argv);
      return { stdout: JSON.stringify(CANNED), stderr: "" };
    };
    const engine = makeEngineRunner(exec);
    await engine({ ...base });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("--tile-base");
  });

  it("relays a BRouter/Nominatim failure plainly", async () => {
    const exec = async () => {
      const err = new Error("Command failed") as Error & { stderr: string };
      err.stderr = "BRouter returned no track — check waypoints/profile.";
      throw err;
    };
    const engine = makeEngineRunner(exec);
    await expect(engine({ ...base })).rejects.toThrow(
      /route engine failed: BRouter returned no track/,
    );
  });

  it("forces OpenTopoMap by blanking OS_API_KEY in the child env", async () => {
    const prev = process.env.OS_API_KEY;
    process.env.OS_API_KEY = "live-key";
    try {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const engine = makeEngineRunner(async (_file, _argv, opts) => {
        capturedEnv = opts.env;
        return { stdout: JSON.stringify(CANNED), stderr: "" };
      });

      await engine({ ...base, basemap: "opentopo" });
      expect(capturedEnv?.OS_API_KEY).toBe("");

      await engine({ ...base, basemap: "os" });
      expect(capturedEnv?.OS_API_KEY).toBe("live-key");
    } finally {
      if (prev === undefined) delete process.env.OS_API_KEY;
      else process.env.OS_API_KEY = prev;
    }
  });
});

describe("runSaveRoute", () => {
  let dataDir: string;
  let vault: string;

  function seedDraft(id: string, gpxName: string): void {
    const dir = path.join(dataDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, gpxName), "<gpx>draft</gpx>", "utf8");
  }

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "trails-data-"));
    vault = mkdtempSync(path.join(tmpdir(), "trails-vault-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  });

  it("copies the draft GPX into Travel/ and returns the vault path", () => {
    const id = "a1b2c3d4e5f60718";
    seedDraft(id, "Sat Loop.gpx");

    const result = runSaveRoute({ vault, dataDir }, { id });

    expect(result).toBe("saved Travel/Sat Loop.gpx");
    const target = path.join(vault, "Travel", "Sat Loop.gpx");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("<gpx>draft</gpx>");
  });

  it("honours a supplied filename and adds a .gpx extension if missing", () => {
    const id = "00112233aabbccdd";
    seedDraft(id, "Sat Loop.gpx");

    const result = runSaveRoute({ vault, dataDir }, { id, filename: "Bolton Abbey loop" });

    expect(result).toBe("saved Travel/Bolton Abbey loop.gpx");
    expect(existsSync(path.join(vault, "Travel", "Bolton Abbey loop.gpx"))).toBe(true);
  });

  it("reports 'updated' when overwriting an existing Travel file", () => {
    const id = "0123456789abcdef";
    seedDraft(id, "Loop.gpx");
    runSaveRoute({ vault, dataDir }, { id });
    const second = runSaveRoute({ vault, dataDir }, { id });
    expect(second).toBe("updated Travel/Loop.gpx");
  });

  it("refuses an unknown id", () => {
    expect(() => runSaveRoute({ vault, dataDir }, { id: "deadbeefdeadbeef" })).toThrow(
      /unknown draft id/,
    );
  });

  it("rejects an id that is not exactly 16 hex chars (typo / traversal)", () => {
    // Strict validation refuses anything off-format, so a mistyped id can't be
    // coerced into a real draft and traversal can't escape the data dir.
    for (const bad of ["../../etc/passwd", "a1b2c3d4e5f6071", "a1b2c3d4e5f60718x", "GHIJ"]) {
      expect(() => runSaveRoute({ vault, dataDir }, { id: bad })).toThrow(
        /invalid draft id/,
      );
    }
    expect(existsSync(path.join(vault, "Travel"))).toBe(false);
  });
});
