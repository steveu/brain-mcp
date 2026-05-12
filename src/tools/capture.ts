import { existsSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { read, resolveUnderVault } from "../vault-fs.js";
import type { WriteDeps, WriteTool } from "./types.js";

export type CaptureArgs = {
  thought: string;
};

function todayInLondon(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

function appendWithBlankLine(existing: string, addition: string): string {
  const trimmed = addition.trim();
  if (existing.length === 0) return trimmed + "\n";
  const trailingNewlines = existing.match(/\n*$/)?.[0].length ?? 0;
  const padding = "\n".repeat(Math.max(0, 2 - trailingNewlines));
  return existing + padding + trimmed + "\n";
}

export function runCapture(deps: WriteDeps, args: CaptureArgs): string {
  const filename = `${todayInLondon()}.md`;
  const target = resolveUnderVault(deps.vault, filename);
  const existing = existsSync(target) ? read(target) : "";
  writeFileSync(target, appendWithBlankLine(existing, args.thought), "utf8");
  return `appended to ${filename}`;
}

export const captureTool: WriteTool<CaptureArgs> = {
  name: "capture",
  title: "Capture a thought",
  description:
    "Append a thought to today's daily note in the personal Obsidian vault. " +
    "Creates the daily note if it does not exist. Today is computed in Europe/London.",
  inputSchema: {
    thought: z.string().min(1).describe("The thought to capture, in the user's voice."),
  },
  run: runCapture,
};
