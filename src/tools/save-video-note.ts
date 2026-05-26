import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveUnderVault } from "../vault-fs.js";
import type { WriteDeps, WriteTool } from "./types.js";

export type KeyPoint = { text: string; seconds: number };

export type SaveVideoNoteArgs = {
  url: string;
  title: string;
  channel: string;
  durationHuman: string;
  gist: string;
  key_points: KeyPoint[];
  takeaways?: string;
};

// Clutter patterns stripped from video titles before use as filenames.
const CLUTTER_PATTERNS: RegExp[] = [
  /\s*\|\s*TEDx?\w*.*/i,
  /\s*\|\s*YouTube.*/i,
  /\s*\|\s*Full\s+(?:Episode|Movie)\b.*/i,
  /\s*\(Official\s+(?:Music\s+)?(?:Video|Audio|Lyric\s+Video)\)/i,
  /\s*\[(?:4K|2K|HD|HQ|Full\s*HD|UHD)\]/i,
];

// Minor words excluded from Title Case capitalisation (except at the start).
const MINOR_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from",
  "in", "into", "nor", "of", "on", "or", "so", "the", "to",
  "up", "via", "yet", "with",
]);

export function toTitleCase(s: string): string {
  const words = s.split(/\s+/);
  return words
    .map((word, i) => {
      const lower = word.toLowerCase();
      // Always capitalise the first and last word; skip minor words in between.
      if (i === 0 || i === words.length - 1 || !MINOR_WORDS.has(lower)) {
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      }
      return lower;
    })
    .join(" ");
}

export function sanitiseTitle(title: string): string {
  let t = title.trim();
  for (const pat of CLUTTER_PATTERNS) {
    t = t.replace(pat, "");
  }
  t = toTitleCase(t.trim());
  // Strip characters unsafe in filenames, then collapse whitespace runs.
  t = t.replace(/[/\\:\0*?"<>|]/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!t) throw new Error("title is empty after sanitisation");
  return t;
}

export function extractYouTubeId(url: string): string | null {
  // youtu.be/<id>
  const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1] ?? null;
  // ?v=<id> query parameter
  const vMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (vMatch) return vMatch[1] ?? null;
  // /embed/<id> or /v/<id>
  const pathMatch = url.match(/\/(?:embed|v)\/([a-zA-Z0-9_-]{11})/);
  if (pathMatch) return pathMatch[1] ?? null;
  return null;
}

export function secondsToTimestamp(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function buildDeepLink(videoId: string, seconds: number): string {
  return `[[${secondsToTimestamp(seconds)}]](https://youtu.be/${videoId}?t=${seconds})`;
}

export function getLondonDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

export function buildNote(args: SaveVideoNoteArgs, videoId: string): string {
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const date = getLondonDate();

  const lines: string[] = [
    "---",
    `source: ${canonicalUrl}`,
    `channel: ${args.channel}`,
    `captured: ${date}`,
    "---",
    "",
    args.gist,
    "",
    "## Key points",
    "",
  ];

  for (const kp of args.key_points) {
    lines.push(`- ${kp.text} — ${buildDeepLink(videoId, kp.seconds)}`);
  }

  lines.push("");
  lines.push("## My takeaways");
  lines.push("");
  if (args.takeaways && args.takeaways.trim()) {
    lines.push(args.takeaways.trim());
  } else {
    lines.push("*(What did this change for you? — fill in on a later pass.)*");
  }

  lines.push("");
  lines.push("## Source");
  lines.push("");
  lines.push(
    `[${args.title}](${canonicalUrl}) — ${args.channel}, ${args.durationHuman}`,
  );
  lines.push("");

  return lines.join("\n");
}

// Scan Sources/*.md frontmatter for a note whose `source:` URL resolves to
// the same YouTube video ID as `url`. ID-based comparison means short links,
// long links, and URLs with extra query params (e.g. &t=42) all match.
export function findExistingNote(sourcesDir: string, url: string): string | null {
  if (!existsSync(sourcesDir)) return null;
  const incomingId = extractYouTubeId(url);
  if (!incomingId) return null;
  let files: string[];
  try {
    files = readdirSync(sourcesDir).filter((f) => f.endsWith(".md"));
  } catch {
    return null;
  }
  for (const file of files) {
    const filePath = path.join(sourcesDir, file);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    // Only inspect the opening frontmatter block.
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch?.[1]) continue;
    const sourceMatch = fmMatch[1].match(/^source:\s*(.+)$/m);
    if (!sourceMatch?.[1]) continue;
    const storedId = extractYouTubeId(sourceMatch[1].trim());
    if (storedId && storedId === incomingId) {
      return path.join("Sources", file);
    }
  }
  return null;
}

export function runSaveVideoNote(deps: WriteDeps, args: SaveVideoNoteArgs): string {
  const videoId = extractYouTubeId(args.url);
  if (!videoId) {
    throw new Error(`could not extract YouTube video ID from URL: ${args.url}`);
  }

  const sourcesDir = resolveUnderVault(deps.vault, "Sources");

  const existing = findExistingNote(sourcesDir, args.url);
  if (existing) {
    return JSON.stringify({ status: "exists", path: existing });
  }

  if (!existsSync(sourcesDir)) mkdirSync(sourcesDir, { recursive: true });

  const filename = sanitiseTitle(args.title);
  const target = resolveUnderVault(deps.vault, "Sources", `${filename}.md`);

  if (existsSync(target)) {
    throw new Error(`note already exists at Sources/${filename}.md (different URL)`);
  }

  writeFileSync(target, buildNote(args, videoId), "utf8");

  const relativePath = `Sources/${filename}.md`;
  return JSON.stringify({ status: "ok", path: target, relativePath });
}

export const saveVideoNoteTool: WriteTool<SaveVideoNoteArgs> = {
  name: "save_video_note",
  title: "Save a video note",
  description:
    "Write one synthesised YouTube video note to vault/Sources/<Title>.md. " +
    "Refuses (returning {status:'exists',path}) if a note with the same source URL already exists — " +
    "this protects hand-written '## My takeaways' sections. " +
    "Returns {status:'ok',path,relativePath} on success. " +
    "Sources/ is a private staging tier; this tool only writes, never reads back.",
  inputSchema: {
    url: z.string().url().describe("YouTube URL for the video."),
    title: z
      .string()
      .min(1)
      .describe(
        "Video title. Clutter suffixes (| TED, (Official Video), [4K] etc.) are stripped automatically; " +
          "the result is converted to Title Case and used as the filename.",
      ),
    channel: z.string().min(1).describe("Channel name."),
    durationHuman: z
      .string()
      .min(1)
      .describe('Human-readable duration, e.g. "12:34" or "1h 4m".'),
    gist: z
      .string()
      .min(1)
      .describe(
        "One-line gist — what this video is and why it is worth keeping. Plain prose, not a label.",
      ),
    key_points: z
      .array(
        z.object({
          text: z.string().min(1).describe("Point text in vault voice."),
          seconds: z
            .number()
            .int()
            .min(0)
            .describe("Integer second offset used for the deep-link."),
        }),
      )
      .min(1)
      .describe(
        "Timestamped key points. Each is rendered as a bullet with a [[mm:ss]] deep-link.",
      ),
    takeaways: z
      .string()
      .optional()
      .describe(
        "User's own takeaways for '## My takeaways'. " +
          "Omit (or pass empty) to write the scaffold placeholder instead.",
      ),
  },
  run: runSaveVideoNote,
};
