import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response, type NextFunction, type Express } from "express";
import { z } from "zod";
import { loadAllowlist } from "./allowlist.js";
import type { AuditSink } from "./audit.js";
import { createOAuthRouter } from "./oauth.js";
import { runFetch, runGrep, runList } from "./vault-read.js";
import {
  IMPORTANCE_VALUES,
  runAddRecipe,
  runCapture,
  runCreateMatch,
} from "./vault-write.js";

export type ServerConfig = {
  vault: string;
  token: string;
  publicUrl?: string;
  oauthStorePath: string;
  allowlistPath: string;
  audit: AuditSink;
};

export function createServer(config: ServerConfig): Express {
  const { vault, token, publicUrl, oauthStorePath, allowlistPath, audit } = config;

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
      const text = runCapture({ vault }, { thought });
      return { content: [{ type: "text", text }] };
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
    async (args) => {
      const text = runCreateMatch({ vault }, args);
      return { content: [{ type: "text", text }] };
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
      const text = runAddRecipe({ vault }, { title, body });
      return { content: [{ type: "text", text }] };
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
      const text = runList({ allowlist, audit }, { path: listPath });
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
      const text = runFetch({ allowlist, audit }, { path: fetchPath });
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
        { allowlist, audit },
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
