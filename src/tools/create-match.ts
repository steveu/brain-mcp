import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { read, resolveUnderVault } from "../vault-fs.js";
import type { WriteDeps, WriteTool } from "./types.js";

const IMPORTANCE_VALUES = [
  "league",
  "cup",
  "cup-final",
  "friendly",
  "tournament",
] as const;
type Importance = (typeof IMPORTANCE_VALUES)[number];

export type CreateMatchArgs = {
  opposition: string;
  team: string;
  date?: string;
  pitch_type?: string;
  pitch_condition?: string;
  focus_area?: string;
  importance?: Importance;
  notes?: string;
};

function todayInLondon(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

// Fills an empty frontmatter field (`field:` with only whitespace after the colon).
function setEmptyField(src: string, field: string, value: string): string {
  const re = new RegExp(`^${field}:[ \\t]*$`, "m");
  if (!re.test(src)) {
    throw new Error(`template missing empty '${field}:' field`);
  }
  return src.replace(re, `${field}: ${value}`);
}

// Overrides a frontmatter field that already has a default value (`field: <value>`).
function overrideField(src: string, field: string, value: string): string {
  const re = new RegExp(`^${field}:[ \\t]*[^\\n]*$`, "m");
  if (!re.test(src)) {
    throw new Error(`template missing '${field}:' field`);
  }
  return src.replace(re, `${field}: ${value}`);
}

function fillMatchTemplate(
  template: string,
  vars: {
    date: string;
    opposition: string;
    team: string;
    pitch_type?: string;
    pitch_condition?: string;
    focus_area?: string;
    importance?: Importance;
    notes?: string;
  },
): string {
  let out = template;
  out = setEmptyField(out, "date", vars.date);
  out = setEmptyField(out, "opposition", vars.opposition);
  out = setEmptyField(out, "team", vars.team);
  if (vars.pitch_type) out = overrideField(out, "pitch_type", vars.pitch_type);
  if (vars.pitch_condition) out = setEmptyField(out, "pitch_condition", vars.pitch_condition);
  if (vars.focus_area) out = setEmptyField(out, "focus_area", vars.focus_area);
  if (vars.importance) out = overrideField(out, "importance", vars.importance);

  out = out.replaceAll("{{opposition}}", vars.opposition);
  out = out.replaceAll("{{date}}", vars.date);
  out = out.replaceAll("{{notes}}", vars.notes ?? "");
  out = out.replaceAll("{{focus_area}}", vars.focus_area ?? "");

  return out;
}

export function runCreateMatch(deps: WriteDeps, args: CreateMatchArgs): string {
  const cleanOpposition = args.opposition.replace(/[\\/\0]/g, "").trim();
  const cleanTeam = args.team.replace(/[\\/\0]/g, "").trim();
  if (!cleanOpposition) throw new Error("opposition is empty after cleaning");
  if (!cleanTeam) throw new Error("team is empty after cleaning");

  const resolvedDate = args.date ?? todayInLondon();

  const templatePath = resolveUnderVault(deps.vault, "Templates", "Match.md");
  if (!existsSync(templatePath)) {
    throw new Error("template not found at Templates/Match.md");
  }
  const template = read(templatePath);
  const filled = fillMatchTemplate(template, {
    date: resolvedDate,
    opposition: cleanOpposition,
    team: cleanTeam,
    pitch_type: args.pitch_type?.trim(),
    pitch_condition: args.pitch_condition?.trim(),
    focus_area: args.focus_area?.trim(),
    importance: args.importance,
    notes: args.notes?.trim(),
  });

  const matchesDir = resolveUnderVault(deps.vault, "Matches");
  if (!existsSync(matchesDir)) mkdirSync(matchesDir, { recursive: true });
  const filename = `${resolvedDate} — ${cleanTeam} vs ${cleanOpposition}.md`;
  const target = resolveUnderVault(deps.vault, "Matches", filename);
  if (existsSync(target)) {
    throw new Error(`match already exists: Matches/${filename}`);
  }
  writeFileSync(target, filled, "utf8");
  return `created Matches/${filename}`;
}

export const createMatchTool: WriteTool<CreateMatchArgs> = {
  name: "create_match",
  title: "Create a match note",
  description:
    "Create a match note in the vault for <team> vs <opposition>. The note is filed at " +
    "Matches/<date> — <team> vs <opposition>.md; refuses to overwrite if a file already " +
    "exists at that path. Returns the created vault-relative path. " +
    "Required args: opposition, team. Optional args (omit to accept defaults): " +
    "date (YYYY-MM-DD; defaults to today in Europe/London), " +
    "pitch_type (defaults to 'grass'), " +
    "importance (one of league/cup/cup-final/friendly/tournament; defaults to 'league'), " +
    "pitch_condition, focus_area, notes (no defaults; left blank if omitted). " +
    "Post-match fields (result, position, minutes, ratings, event tallies) are not set " +
    "by this tool — the user fills those in directly after the match.",
  inputSchema: {
    opposition: z
      .string()
      .min(1)
      .describe("Opposition team name, e.g. 'Heslington'."),
    team: z
      .string()
      .min(1)
      .describe(
        "The user's team for this match, e.g. 'Fulford FC' or 'Fulford School'. Used verbatim in frontmatter and filename.",
      ),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        "Match date as YYYY-MM-DD. Omit to default to today (Europe/London).",
      ),
    pitch_type: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Pitch surface, e.g. 'grass', '3G', 'astroturf'. Omit to keep the template default of 'grass'.",
      ),
    pitch_condition: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Pre-match pitch condition if known, e.g. 'wet', 'frozen'. Usually omitted — set post-match.",
      ),
    focus_area: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Pre-match focus area, e.g. 'using your eyes'. Fills the focus_area frontmatter field and the {{focus_area}} placeholder in the body.",
      ),
    importance: z
      .enum(IMPORTANCE_VALUES)
      .optional()
      .describe(
        "Match importance. One of: league, cup, cup-final, friendly, tournament. Omit to keep the template default of 'league'.",
      ),
    notes: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Free-form pre-match context (competition name, age group, venue notes) that doesn't fit a frontmatter field. Inserted under the body's '## Context' section.",
      ),
  },
  run: runCreateMatch,
};
