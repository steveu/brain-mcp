import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { resolveUnderVault } from "../vault-fs.js";
import type { WriteDeps, WriteTool } from "./types.js";

// walk_route / save_route — expose the `trails` route engine (route.py, in the
// skills repo) to claude.ai. walk_route shells the engine to build a draft GPX +
// map HTML into a scratch dir and returns plain-text metrics (so they render
// inline in chat) plus a map URL; save_route copies a chosen draft into the
// vault's Travel/ folder — the gate before a route is "final".
//
// The engine needs full network (BRouter/Nominatim), so it runs here on the Mac,
// not in the claude.ai sandbox. Mirrors capture → capture-cloud.

const execFileAsync = promisify(execFile);

// --- engine contract (route.py's JSON stdout; see trails/route.py main()) ---

export type LatLon = [number, number];

export type EngineMetrics = {
  name: string;
  profile: string;
  miles: number;
  length_m: number;
  ascent_m: number;
  trackpoints: number;
  retrace_pct: number;
  car_m: number;
  foot_m: number;
  other_m: number;
  waypoints: { label: string | null; ll: LatLon }[];
  pins: { label: string; type: string; ll: LatLon }[];
  gpx: string;
  html: string;
};

export type EngineParams = {
  routePy: string;
  waypoints: string; // pipe-separated, the route.py grammar
  pins?: string;
  name: string;
  outDir: string;
  profile: string;
  basemap?: Basemap;
  tileBase?: string;
};

export type EngineRunner = (params: EngineParams) => Promise<EngineMetrics>;

const BASEMAPS = ["os", "opentopo"] as const;
type Basemap = (typeof BASEMAPS)[number];

// route.py reads OS_API_KEY from its inherited env (OS Outdoor tiles) and falls
// back to OpenTopoMap when absent. Forcing OpenTopoMap is therefore just running
// the child with OS_API_KEY blanked — no engine flag needed.
type ExecFn = (
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

const MAX_BUFFER = 16 * 1024 * 1024;

// Factory so tests can inject a fake exec and assert the shelled argv (including
// the --tile-base retry) without invoking python or the network.
export function makeEngineRunner(exec: ExecFn = execFileAsync as unknown as ExecFn): EngineRunner {
  return async (p: EngineParams): Promise<EngineMetrics> => {
    const baseArgs = [
      p.routePy,
      "--waypoints",
      p.waypoints,
      "--name",
      p.name,
      "--out-dir",
      p.outDir,
      "--profile",
      p.profile,
    ];
    if (p.pins) baseArgs.push("--pins", p.pins);

    const env =
      p.basemap === "opentopo" ? { ...process.env, OS_API_KEY: "" } : process.env;
    const argv = p.tileBase ? [...baseArgs, "--tile-base", p.tileBase] : baseArgs;

    try {
      const { stdout } = await exec("python3", argv, { env, maxBuffer: MAX_BUFFER });
      return JSON.parse(stdout) as EngineMetrics;
    } catch (err) {
      const stderr = String((err as { stderr?: unknown })?.stderr ?? "");
      // The engine gains --tile-base in a later slice (skills repo). Until then
      // argparse rejects it; fall back to a key-ful local render so the tool
      // still works against an older engine.
      if (p.tileBase && /unrecognized arguments/.test(stderr) && stderr.includes("--tile-base")) {
        const { stdout } = await exec("python3", baseArgs, { env, maxBuffer: MAX_BUFFER });
        return JSON.parse(stdout) as EngineMetrics;
      }
      const message = stderr.trim() || String((err as Error)?.message ?? err);
      throw new Error(`route engine failed: ${message}`);
    }
  };
}

const realEngine = makeEngineRunner();

// --- ids + geometry ---

// Deterministic from the route name: same name ⇒ same id ⇒ same scratch dir,
// overwritten in place. An optional server-side salt makes the resulting map
// URL unguessable without changing the determinism for a given name.
export function deriveId(name: string, salt?: string): string {
  const h = createHash("sha256");
  if (salt) h.update(`${salt}\n`);
  h.update(name);
  return h.digest("hex").slice(0, 16);
}

function haversineKm(a: LatLon, b: LatLon): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// A waypoint resolving tens of km from the rest is almost always a bad geocode
// (wrong town/country). Flag it rather than silently routing a wild line.
const OUTLIER_KM = 50;

type Outlier = { label: string | null; ll: LatLon; km: number };

export function findOutliers(waypoints: EngineMetrics["waypoints"]): Outlier[] {
  if (waypoints.length < 3) return [];
  const lat = waypoints.reduce((s, w) => s + w.ll[0], 0) / waypoints.length;
  const lon = waypoints.reduce((s, w) => s + w.ll[1], 0) / waypoints.length;
  const centroid: LatLon = [lat, lon];
  return waypoints
    .map((w) => ({ label: w.label, ll: w.ll, km: haversineKm(w.ll, centroid) }))
    .filter((w) => w.km > OUTLIER_KM);
}

// --- formatting ---

const fmt = (ll: LatLon) => `${ll[0].toFixed(5)}, ${ll[1].toFixed(5)}`;

function formatResponse(m: EngineMetrics, id: string, trailsHost?: string): string {
  const lines: string[] = [
    `${m.name} — ${m.miles} mi · ${m.ascent_m} m ascent · ${m.retrace_pct}% retrace`,
    `Roads with cars: ${m.car_m} m · foot-only paths: ${m.foot_m} m · other: ${m.other_m} m · ${m.trackpoints} trackpoints`,
  ];

  const outliers = findOutliers(m.waypoints);
  if (outliers.length) {
    lines.push("");
    lines.push("⚠ Possible bad geocode — these resolved far from the rest of the route:");
    for (const o of outliers) {
      lines.push(`  • ${o.label ?? "(unnamed)"} → ${fmt(o.ll)} (${Math.round(o.km)} km out)`);
    }
  }

  lines.push("");
  lines.push("Waypoints (resolved):");
  for (const w of m.waypoints) {
    lines.push(`  • ${w.label ?? "(unnamed coord)"} — ${fmt(w.ll)}`);
  }
  if (m.pins.length) {
    lines.push("Pins:");
    for (const p of m.pins) {
      lines.push(`  • ${p.label} [${p.type}] — ${fmt(p.ll)}`);
    }
  }

  lines.push("");
  if (trailsHost) {
    lines.push(`Map: ${trailsHost.replace(/\/+$/, "")}/${id}`);
  } else {
    lines.push("Map: URL unavailable (TRAILS_HOST not set on the server).");
  }
  lines.push(`Draft id: ${id} — call save_route with this id to file the GPX in Travel/.`);
  return lines.join("\n");
}

function sanitiseName(name: string): string {
  return name.replace(/[\\/\0]/g, "").trim();
}

// --- walk_route ---

export type WalkRouteArgs = {
  waypoints: string;
  name: string;
  pins?: string;
  profile?: string;
  basemap?: Basemap;
};

export type WalkRouteDeps = {
  runEngine: EngineRunner;
  dataDir: string;
  routePy: string;
  trailsHost?: string;
  tileBase?: string;
  idSalt?: string;
};

function defaultDataDir(): string {
  return process.env.TRAILS_DATA_DIR || path.join(homedir(), "data", "trails");
}

function defaultWalkRouteDeps(): WalkRouteDeps {
  return {
    runEngine: realEngine,
    dataDir: defaultDataDir(),
    routePy: process.env.ROUTE_PY || path.join(homedir(), "skills", "trails", "route.py"),
    trailsHost: process.env.TRAILS_HOST || undefined,
    tileBase: process.env.TRAILS_TILE_BASE || undefined,
    idSalt: process.env.TRAILS_ID_SALT || undefined,
  };
}

export async function runWalkRoute(deps: WalkRouteDeps, args: WalkRouteArgs): Promise<string> {
  const name = sanitiseName(args.name);
  if (!name) throw new Error("name is empty after cleaning");

  const id = deriveId(name, deps.idSalt);
  const outDir = path.join(deps.dataDir, id);
  mkdirSync(outDir, { recursive: true });

  const metrics = await deps.runEngine({
    routePy: deps.routePy,
    waypoints: args.waypoints,
    pins: args.pins,
    name,
    outDir,
    profile: args.profile ?? "hiking-beta",
    basemap: args.basemap,
    tileBase: deps.tileBase,
  });

  return formatResponse(metrics, id, deps.trailsHost);
}

export const walkRouteTool: WriteTool<WalkRouteArgs> = {
  name: "walk_route",
  title: "Build a walking/running route",
  description:
    "Build a clean GPX walking or running route on real OSM paths from a set of waypoints, " +
    "returning distance/ascent/retrace metrics, the resolved geocodes, and a map URL for an " +
    "OS-detail preview. Routes with BRouter over the network (runs on the Mac, not the " +
    "claude.ai sandbox). Writes a draft GPX (with named <wpt> pins) and map HTML to a scratch " +
    "dir keyed by the route name — re-running with the same name overwrites the draft. Nothing " +
    "is filed in the vault until save_route is called. " +
    "waypoints grammar (pipe-separated, in order): 'lat,lon' (routed, no pin) | " +
    "'lat,lon@Name::desc' (coordinate with a labelled pin and optional tap-text) | " +
    "'Place name::desc' (geocoded; the name becomes the pin label). " +
    "pins use the same grammar for off-route landmarks — marked but NOT routed through.",
  inputSchema: {
    waypoints: z
      .string()
      .min(1)
      .describe(
        "Pipe-separated routed waypoints in order, e.g. " +
          "'Catgill Farm|54.0089,-1.8889@Cavendish Pavilion::Cafe stop|Bolton Abbey'. " +
          "Each is 'lat,lon', 'lat,lon@Name::desc', or 'Place name::desc'. Min two.",
      ),
    name: z
      .string()
      .min(1)
      .describe(
        "Route name. Used for the draft filename and to key the scratch dir (same name " +
          "overwrites the previous draft). Keep it stable across edits to the same route.",
      ),
    pins: z
      .string()
      .optional()
      .describe(
        "Optional pipe-separated off-route landmarks (same grammar as waypoints), marked as " +
          "pins but not routed through — for a viewpoint or feature beside the line.",
      ),
    profile: z
      .string()
      .optional()
      .describe(
        "BRouter profile. Defaults to 'hiking-beta' (avoids busy roads); 'trekking' tolerates them.",
      ),
    basemap: z
      .enum(BASEMAPS)
      .optional()
      .describe(
        "Map preview basemap: 'os' (OS Outdoor; needs OS_API_KEY on the server) or 'opentopo' " +
          "(OpenTopoMap, no key). Defaults to OS when a key is configured, else OpenTopoMap.",
      ),
  },
  run: (_deps, args) => runWalkRoute(defaultWalkRouteDeps(), args),
};

// --- save_route ---

export type SaveRouteArgs = {
  id: string;
  filename?: string;
};

export type SaveRouteDeps = {
  vault: string;
  dataDir: string;
};

function defaultSaveRouteDeps(vault: string): SaveRouteDeps {
  return { vault, dataDir: defaultDataDir() };
}

export function runSaveRoute(deps: SaveRouteDeps, args: SaveRouteArgs): string {
  // Validate the id strictly rather than sanitising it: a mistyped id must be
  // rejected, not silently coerced into a different (valid) draft. Requiring the
  // exact 16-hex format also rules out any path traversal.
  const id = String(args.id ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(id)) {
    throw new Error("invalid draft id — expected 16 hex characters");
  }

  const draftDir = path.join(deps.dataDir, id);
  if (!existsSync(draftDir)) throw new Error(`unknown draft id: ${id}`);

  const draftGpx = readdirSync(draftDir).find((f) => f.toLowerCase().endsWith(".gpx"));
  if (!draftGpx) throw new Error(`no GPX found in draft ${id}`);
  const src = path.join(draftDir, draftGpx);

  let filename = (args.filename ?? draftGpx).replace(/[\\/\0]/g, "").trim();
  if (!filename) throw new Error("filename is empty after cleaning");
  if (!filename.toLowerCase().endsWith(".gpx")) filename += ".gpx";

  const travelDir = resolveUnderVault(deps.vault, "Travel");
  if (!existsSync(travelDir)) mkdirSync(travelDir, { recursive: true });
  const target = resolveUnderVault(deps.vault, "Travel", filename);

  const overwriting = existsSync(target);
  copyFileSync(src, target);
  return `${overwriting ? "updated" : "saved"} Travel/${filename}`;
}

export const saveRouteTool: WriteTool<SaveRouteArgs> = {
  name: "save_route",
  title: "Save a route draft to the vault",
  description:
    "File a previously-built route draft into the vault's Travel/ folder as a final GPX. " +
    "Pass the draft id returned by walk_route. Copies the draft's GPX to Travel/<filename>.gpx " +
    "and returns the vault-relative path; refuses an unknown id. This is the gate before a " +
    "route is treated as final — only call it once the user has approved the route shape.",
  inputSchema: {
    id: z
      .string()
      .min(1)
      .describe("The draft id returned by walk_route (16 hex characters)."),
    filename: z
      .string()
      .optional()
      .describe(
        "Optional target filename under Travel/. Defaults to the draft's own name. " +
          "A .gpx extension is added if missing.",
      ),
  },
  run: (deps, args) => runSaveRoute(defaultSaveRouteDeps(deps.vault), args),
};
