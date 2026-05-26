import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { WriteTool } from "./types.js";

const execFileAsync = promisify(execFile);
// yt-dlp's single-video JSON can include large caption manifest payloads across
// languages/formats, so keep a generous cap rather than walk-route's smaller one.
const MAX_BUFFER = 64 * 1024 * 1024;
const CAPTION_FETCH_TIMEOUT_MS = 30_000;
const LANGS = ["en", "en-GB", "en-US", "en-orig"] as const;

export type CaptionKind = "manual" | "auto";

export type TranscriptMeta = {
  id: string;
  title: string;
  channel: string;
  channelUrl: string | null;
  duration: number;
  durationHuman: string | null;
  uploadDate: string | null;
  webpageUrl: string;
};

export type TranscriptLine = { t: number; text: string };
export type CaptionTrack = { kind: CaptionKind; lang: string; url: string };

export type FetchTranscriptResult =
  | ({ status: "ok"; captionKind: CaptionKind; captionLang: string; lineCount: number; charCount: number; transcript: string } & TranscriptMeta)
  | ({ status: "no-transcript"; reason: string } & TranscriptMeta)
  | { status: "error"; reason: string; raw?: string };

export type FetchTranscriptArgs = { url: string };

type ExecFn = (
  file: string,
  args: string[],
  opts: { maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

type FetchJson = (url: string) => Promise<unknown>;

export type FetchTranscriptDeps = {
  exec: ExecFn;
  fetchJson: FetchJson;
  ytdlpBin: string;
  nodeBin: string;
};

export function mapYtdlpError(stderr: string): string | null {
  if (/private video|video is private/i.test(stderr)) return "The video is private.";
  if (/video unavailable|has been removed|no longer available/i.test(stderr)) return "The video isn't available any more.";
  if (/geo.?block|not available in your country/i.test(stderr)) return "The video isn't available in this region.";
  if (/members.?only|join this channel/i.test(stderr)) return "The video is for channel members only.";
  if (/age.?restrict/i.test(stderr)) return "The video is age-restricted and needs a signed-in session.";
  if (/premieres? in|premieres? on|this live event will begin|scheduled (start )?time/i.test(stderr)) return "The video hasn't aired yet.";
  if (/sign in to confirm|bot detection|please sign in|not a bot/i.test(stderr)) return "YouTube returned a bot-detection challenge for this fetch.";
  if (/is not a valid URL|unsupported url/i.test(stderr)) return "That doesn't look like a supported video URL.";
  return null;
}

export function humanDuration(secs: number): string | null {
  if (!secs || secs < 0) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function stamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function flattenJson3(events: unknown): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  if (!Array.isArray(events)) return lines;

  for (const ev of events) {
    const e = ev as { segs?: { utf8?: unknown }[]; tStartMs?: unknown };
    const text = (Array.isArray(e.segs) ? e.segs : [])
      .map((s) => (typeof s.utf8 === "string" ? s.utf8 : ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;

    const t = typeof e.tStartMs === "number" ? e.tStartMs : 0;
    const prev = lines[lines.length - 1];
    if (prev && (text.startsWith(prev.text) || prev.text.startsWith(text))) {
      if (text.length > prev.text.length) prev.text = text;
    } else {
      lines.push({ t, text });
    }
  }

  return lines;
}

export function pickTrack(json: unknown): CaptionTrack | null {
  const root = json as Record<string, unknown>;
  for (const [kind, key] of [
    ["manual", "subtitles"],
    ["auto", "automatic_captions"],
  ] as const) {
    const bucket = root[key] as Record<string, unknown> | undefined;
    if (!bucket || typeof bucket !== "object") continue;
    for (const lang of LANGS) {
      const tracks = bucket[lang];
      if (!Array.isArray(tracks)) continue;
      const json3 = tracks.find((t) => {
        const track = t as { ext?: unknown; url?: unknown };
        return track.ext === "json3" && typeof track.url === "string" && track.url.length > 0;
      }) as { url: string } | undefined;
      if (json3) return { kind, lang, url: json3.url };
    }
  }
  return null;
}

function metaFrom(json: unknown, fallbackUrl: string): TranscriptMeta {
  const j = json as Record<string, unknown>;
  const duration = Number(j.duration ?? 0);
  const channelUrl = j.uploader_url ?? j.channel_url;
  return {
    id: String(j.id ?? ""),
    title: String(j.title ?? ""),
    channel: String(j.uploader ?? j.channel ?? ""),
    channelUrl: typeof channelUrl === "string" ? channelUrl : null,
    duration,
    durationHuman: humanDuration(duration),
    uploadDate: typeof j.upload_date === "string" ? j.upload_date : null,
    webpageUrl: typeof j.webpage_url === "string" ? j.webpage_url : fallbackUrl,
  };
}

function tail(stderr: string): string {
  return stderr.trim().split("\n").slice(-3).join("\n");
}

export function ytdlpArgs(url: string, nodeBin: string): string[] {
  return [
    "--dump-json",
    "--skip-download",
    "--no-playlist",
    "--no-write-playlist-metafiles",
    "--js-runtimes",
    `node:${nodeBin}`,
    "--remote-components",
    "ejs:github",
    "--extractor-args",
    "youtube:player_client=mweb",
    url,
  ];
}

export async function runFetchTranscript(
  deps: FetchTranscriptDeps,
  args: FetchTranscriptArgs,
): Promise<FetchTranscriptResult> {
  let stdout: string;
  try {
    ({ stdout } = await deps.exec(deps.ytdlpBin, ytdlpArgs(args.url, deps.nodeBin), {
      maxBuffer: MAX_BUFFER,
    }));
  } catch (err) {
    const e = err as Error & { stderr?: unknown; code?: unknown };
    const stderr = String(e.stderr ?? e.message ?? "");
    if (e.code === "ENOENT") {
      return { status: "error", reason: `yt-dlp not found (looked for "${deps.ytdlpBin}").` };
    }
    return {
      status: "error",
      reason: mapYtdlpError(stderr) ?? "yt-dlp failed to fetch the video.",
      raw: tail(stderr),
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { status: "error", reason: "yt-dlp returned output that was not valid JSON." };
  }

  if ((json as { live_status?: unknown }).live_status === "is_live") {
    return {
      status: "error",
      reason: "The video is a live broadcast in progress — try again once the stream ends.",
    };
  }

  const meta = metaFrom(json, args.url);
  const track = pickTrack(json);
  if (!track) {
    return {
      status: "no-transcript",
      reason: "No English captions (manual or auto) are available for this video.",
      ...meta,
    };
  }

  let captionJson: unknown;
  try {
    captionJson = await deps.fetchJson(track.url);
  } catch (err) {
    return {
      status: "no-transcript",
      reason: `Found an English ${track.kind} caption track but couldn't fetch it (${(err as Error).message}).`,
      ...meta,
    };
  }

  const lines = flattenJson3((captionJson as { events?: unknown }).events);
  if (lines.length === 0) {
    return { status: "no-transcript", reason: "The English caption track was empty after parsing.", ...meta };
  }

  const transcript = lines.map((l) => `[${stamp(l.t)}] ${l.text}`).join("\n");
  return {
    status: "ok",
    ...meta,
    captionKind: track.kind,
    captionLang: track.lang,
    lineCount: lines.length,
    charCount: transcript.length,
    transcript,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(CAPTION_FETCH_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function defaultDeps(): FetchTranscriptDeps {
  return {
    exec: execFileAsync as unknown as ExecFn,
    fetchJson,
    ytdlpBin: process.env.YTDLP_BIN || "yt-dlp",
    nodeBin: process.env.NODE_BIN || process.execPath,
  };
}

const DEFAULT_DEPS = defaultDeps();

export const fetchTranscriptTool: WriteTool<FetchTranscriptArgs> = {
  name: "fetch_transcript",
  title: "Fetch a YouTube transcript",
  description:
    "Fetch YouTube video metadata and the timestamped English transcript inline. " +
    "Runs yt-dlp on the server with the bgutil-aware YouTube flags, prefers manual English " +
    "subtitles over auto-captions, and returns JSON with status 'ok', 'no-transcript', or 'error'.",
  inputSchema: {
    url: z.string().url().describe("YouTube video URL."),
  },
  run: async (_deps, args) => JSON.stringify(await runFetchTranscript(DEFAULT_DEPS, args)),
};
