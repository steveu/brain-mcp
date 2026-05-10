import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response, type NextFunction, type Express } from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadAllowlist } from "./allowlist.js";
import { createOAuthRouter } from "./oauth.js";
import { runFetch, runGrep, runList } from "./vault.js";

export type ServerConfig = {
  vault: string;
  token: string;
  publicUrl?: string;
  oauthStorePath: string;
  allowlistPath: string;
  auditLogPath: string;
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

const IMPORTANCE_VALUES = ["league", "cup", "cup-final", "friendly", "tournament"] as const;
type Importance = (typeof IMPORTANCE_VALUES)[number];

export function fillMatchTemplate(
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
  // Fills an empty frontmatter field (`field:` with only whitespace after the colon).
  const setEmptyField = (src: string, field: string, value: string): string => {
    const re = new RegExp(`^${field}:[ \\t]*$`, "m");
    if (!re.test(src)) {
      throw new Error(`template missing empty '${field}:' field`);
    }
    return src.replace(re, `${field}: ${value}`);
  };
  // Overrides a frontmatter field that already has a default value (`field: <value>`).
  const overrideField = (src: string, field: string, value: string): string => {
    const re = new RegExp(`^${field}:[ \\t]*[^\\n]*$`, "m");
    if (!re.test(src)) {
      throw new Error(`template missing '${field}:' field`);
    }
    return src.replace(re, `${field}: ${value}`);
  };

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

export function createServer(config: ServerConfig): Express {
  const { vault, token, publicUrl, oauthStorePath, allowlistPath, auditLogPath } = config;

  function vaultPath(...parts: string[]): string {
    const target = path.resolve(vault, ...parts);
    if (target !== vault && !target.startsWith(vault + path.sep)) {
      throw new Error("path escapes vault");
    }
    return target;
  }

  // Re-loaded per call so edits to the allowlist file take effect without restart.
  function readAllowlistOrThrow() {
    return loadAllowlist(vault, allowlistPath);
  }

  const server = new McpServer({
    name: "brain",
    version: "0.1.0",
  });

  server.registerTool(
    "capture",
    {
      title: "Capture a thought",
      description:
        "Append a thought to today's daily note in the personal Obsidian vault. " +
        "Creates the daily note if it does not exist. Today is computed in Europe/London.",
      inputSchema: {
        thought: z.string().min(1).describe("The thought to capture, in the user's voice."),
      },
    },
    async ({ thought }) => {
      const filename = `${todayInLondon()}.md`;
      const target = vaultPath(filename);
      const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
      writeFileSync(target, appendWithBlankLine(existing, thought), "utf8");
      return {
        content: [{ type: "text", text: `appended to ${filename}` }],
      };
    },
  );

  server.registerTool(
    "create_match",
    {
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
    },
    async ({
      opposition,
      team,
      date,
      pitch_type,
      pitch_condition,
      focus_area,
      importance,
      notes,
    }) => {
      const cleanOpposition = opposition.replace(/[\\/\0]/g, "").trim();
      const cleanTeam = team.replace(/[\\/\0]/g, "").trim();
      if (!cleanOpposition) throw new Error("opposition is empty after cleaning");
      if (!cleanTeam) throw new Error("team is empty after cleaning");

      const resolvedDate = date ?? todayInLondon();

      const templatePath = vaultPath("Templates", "Match.md");
      if (!existsSync(templatePath)) {
        throw new Error("template not found at Templates/Match.md");
      }
      const template = readFileSync(templatePath, "utf8");
      const filled = fillMatchTemplate(template, {
        date: resolvedDate,
        opposition: cleanOpposition,
        team: cleanTeam,
        pitch_type: pitch_type?.trim(),
        pitch_condition: pitch_condition?.trim(),
        focus_area: focus_area?.trim(),
        importance,
        notes: notes?.trim(),
      });

      const matchesDir = vaultPath("Matches");
      if (!existsSync(matchesDir)) mkdirSync(matchesDir, { recursive: true });
      const filename = `${resolvedDate} — ${cleanTeam} vs ${cleanOpposition}.md`;
      const target = vaultPath("Matches", filename);
      if (existsSync(target)) {
        throw new Error(`match already exists: Matches/${filename}`);
      }
      writeFileSync(target, filled, "utf8");
      return {
        content: [{ type: "text", text: `created Matches/${filename}` }],
      };
    },
  );

  server.registerTool(
    "add_recipe",
    {
      title: "Add a recipe",
      description:
        "Create a new recipe note at vault/Recipes/<title>.md with the given markdown body. " +
        "The body should already match the vault's recipe convention (frontmatter + sections); " +
        "the tool only writes the file. Refuses to overwrite an existing recipe with the same title.",
      inputSchema: {
        title: z
          .string()
          .min(1)
          .describe("Recipe title, used verbatim as the filename (preserve case and spaces)."),
        body: z.string().min(1).describe("Full markdown body of the recipe note."),
      },
    },
    async ({ title, body }) => {
      const cleanedTitle = title.replace(/[\\/\0]/g, "").trim();
      if (!cleanedTitle) throw new Error("title is empty after cleaning");
      const recipesDir = vaultPath("Recipes");
      if (!existsSync(recipesDir)) mkdirSync(recipesDir, { recursive: true });
      const target = vaultPath("Recipes", `${cleanedTitle}.md`);
      if (existsSync(target)) {
        throw new Error(`recipe already exists: Recipes/${cleanedTitle}.md`);
      }
      const content = body.endsWith("\n") ? body : body + "\n";
      writeFileSync(target, content, "utf8");
      return {
        content: [{ type: "text", text: `created Recipes/${cleanedTitle}.md` }],
      };
    },
  );

  server.registerTool(
    "list",
    {
      title: "List allowlisted vault notes",
      description:
        "Recursively list the vault notes the user has chosen to expose, with each note's frontmatter and first H1 inlined so you can pick candidates without fetching every file. " +
        "Scope is the brain-mcp allowlist (see ./allowlist in the vault repo) — anything outside is private and unavailable. " +
        "Use this first for any question that might be answered from the vault: meal planning / cooking ideas (Recipes/), upcoming travel, jetlag, or 'where am I' questions (Travel/), the user's side projects (Projects/), or note-template references (Templates/). " +
        "Pass an optional 'path' (vault-relative, must be inside the allowlist) to scope the listing to one folder or file. " +
        "Wikilinks and markdown links pointing outside the allowlist are replaced with [[redacted]] / [redacted].",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Optional vault-relative path to list, e.g. 'Recipes' or 'Projects/AI.md'. Must resolve inside the allowlist.",
          ),
      },
    },
    async ({ path: listPath }) => {
      const allowlist = readAllowlistOrThrow();
      const text = runList({ allowlist, auditLogPath }, { path: listPath });
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch an allowlisted vault note",
      description:
        "Read a single note from the vault by path. Hard-rejected if the path is not inside the brain-mcp allowlist (see ./allowlist). " +
        "Use after 'list' has surfaced a candidate, or when the user names a note directly. " +
        "Wikilinks and markdown links pointing outside the allowlist are replaced with [[redacted]] / [redacted]; " +
        "the server will not follow those links across the boundary, so don't try to fetch redacted targets.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            "Vault-relative path to a note, e.g. 'Recipes/Lemon, Greens & Sausage Pasta.md'. Must resolve inside the allowlist.",
          ),
      },
    },
    async ({ path: fetchPath }) => {
      const allowlist = readAllowlistOrThrow();
      const text = runFetch({ allowlist, auditLogPath }, { path: fetchPath });
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "grep",
    {
      title: "Search allowlisted vault notes",
      description:
        "Case-insensitive literal substring search across allowlisted vault notes. " +
        "Use when the listing is too long to skim or when the user asks for a keyword (ingredient, project name, place). " +
        "Returns matches grouped by file, each as 'line-number: line-content'. " +
        "Wikilinks and markdown links pointing outside the allowlist are replaced with [[redacted]] / [redacted] in the output. " +
        "Pass an optional 'path' to limit the search to one allowlisted folder.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Literal substring to search for. Case-insensitive. No regex."),
        path: z
          .string()
          .optional()
          .describe(
            "Optional vault-relative folder to limit the search to, e.g. 'Recipes'. Must be inside the allowlist.",
          ),
      },
    },
    async ({ query, path: grepPath }) => {
      const allowlist = readAllowlistOrThrow();
      const text = runGrep(
        { allowlist, auditLogPath },
        { query, path: grepPath },
      );
      return { content: [{ type: "text", text }] };
    },
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  function requireBearer(req: Request, res: Response, next: NextFunction): void {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      if (publicUrl) {
        res.setHeader(
          "WWW-Authenticate",
          `Bearer realm="brain-mcp", resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`,
        );
      }
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  }

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, vault });
  });

  if (publicUrl) {
    app.use(
      createOAuthRouter({
        publicUrl,
        resourceUrl: `${publicUrl}/mcp`,
        accessToken: token,
        storePath: oauthStorePath,
      }),
    );
  }

  app.post("/mcp", requireBearer, async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
