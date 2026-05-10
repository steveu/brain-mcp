import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { read, resolveUnderVault } from "./vault-fs.js";

export type WriteDeps = {
  vault: string;
};

export type CaptureArgs = {
  thought: string;
};

export type AddRecipeArgs = {
  title: string;
  body: string;
};

export const IMPORTANCE_VALUES = [
  "league",
  "cup",
  "cup-final",
  "friendly",
  "tournament",
] as const;
export type Importance = (typeof IMPORTANCE_VALUES)[number];

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

function appendWithBlankLine(existing: string, addition: string): string {
  const trimmed = addition.trim();
  if (existing.length === 0) return trimmed + "\n";
  const trailingNewlines = existing.match(/\n*$/)?.[0].length ?? 0;
  const padding = "\n".repeat(Math.max(0, 2 - trailingNewlines));
  return existing + padding + trimmed + "\n";
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

// ----- capture ------------------------------------------------------------

export function runCapture(deps: WriteDeps, args: CaptureArgs): string {
  const filename = `${todayInLondon()}.md`;
  const target = resolveUnderVault(deps.vault, filename);
  const existing = existsSync(target) ? read(target) : "";
  writeFileSync(target, appendWithBlankLine(existing, args.thought), "utf8");
  return `appended to ${filename}`;
}

// ----- add_recipe ---------------------------------------------------------

export function runAddRecipe(deps: WriteDeps, args: AddRecipeArgs): string {
  const cleanedTitle = args.title.replace(/[\\/\0]/g, "").trim();
  if (!cleanedTitle) throw new Error("title is empty after cleaning");
  const recipesDir = resolveUnderVault(deps.vault, "Recipes");
  if (!existsSync(recipesDir)) mkdirSync(recipesDir, { recursive: true });
  const target = resolveUnderVault(deps.vault, "Recipes", `${cleanedTitle}.md`);
  if (existsSync(target)) {
    throw new Error(`recipe already exists: Recipes/${cleanedTitle}.md`);
  }
  const content = args.body.endsWith("\n") ? args.body : args.body + "\n";
  writeFileSync(target, content, "utf8");
  return `created Recipes/${cleanedTitle}.md`;
}

// ----- create_match -------------------------------------------------------

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
