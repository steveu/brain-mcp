import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createOAuthRouter } from "./oauth.js";

const VAULT = path.resolve(process.env.BRAIN_VAULT ?? path.join(homedir(), "brain", "vault"));
const TOKEN = process.env.BRAIN_MCP_TOKEN;
const PORT = Number(process.env.PORT ?? 8765);
const PUBLIC_URL = process.env.BRAIN_MCP_PUBLIC_URL?.replace(/\/$/, "");
const OAUTH_STORE =
  process.env.BRAIN_MCP_OAUTH_STORE ??
  path.join(homedir(), "data", "brain-mcp", "oauth.json");

if (!TOKEN) {
  console.error("BRAIN_MCP_TOKEN is required");
  process.exit(1);
}
if (!existsSync(VAULT)) {
  console.error(`vault not found at ${VAULT}`);
  process.exit(1);
}

function vaultPath(...parts: string[]): string {
  const target = path.resolve(VAULT, ...parts);
  if (target !== VAULT && !target.startsWith(VAULT + path.sep)) {
    throw new Error("path escapes vault");
  }
  return target;
}

function todayInLondon(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

function nextSaturdayInLondon(): string {
  const parts = todayInLondon().split("-").map(Number);
  const [y, m, d] = parts as [number, number, number];
  const utc = new Date(Date.UTC(y, m - 1, d));
  const daysToAdd = (6 - utc.getUTCDay() + 7) % 7;
  const target = new Date(Date.UTC(y, m - 1, d + daysToAdd));
  const yy = target.getUTCFullYear();
  const mm = String(target.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(target.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function appendWithBlankLine(existing: string, addition: string): string {
  const trimmed = addition.trim();
  if (existing.length === 0) return trimmed + "\n";
  const trailingNewlines = existing.match(/\n*$/)?.[0].length ?? 0;
  const padding = "\n".repeat(Math.max(0, 2 - trailingNewlines));
  return existing + padding + trimmed + "\n";
}

function fillMatchTemplate(
  template: string,
  vars: { date: string; opposition: string; team: string },
): string {
  const setField = (src: string, field: string, value: string): string => {
    const re = new RegExp(`^${field}:[ \\t]*$`, "m");
    if (!re.test(src)) {
      throw new Error(`template missing empty '${field}:' field`);
    }
    return src.replace(re, `${field}: ${value}`);
  };
  let out = template;
  out = setField(out, "date", vars.date);
  out = setField(out, "opposition", vars.opposition);
  out = setField(out, "team", vars.team);
  out = out.replaceAll("{{opposition}}", vars.opposition);
  out = out.replaceAll("{{date}}", vars.date);
  return out;
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
      "Create a new match note at vault/Matches/<date> — <team> vs <opposition>.md, " +
      "based on vault/Templates/Match.md with the date / opposition / team fields and " +
      "the H1 placeholders filled in. Date defaults to the next Saturday on or after " +
      "today (Europe/London). Refuses to overwrite an existing match with the same name. " +
      "Other template fields (result, position, etc.) are left for the user to fill in after the match.",
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
          "Match date as YYYY-MM-DD. Omit to default to the next Saturday on or after today (Europe/London).",
        ),
    },
  },
  async ({ opposition, team, date }) => {
    const cleanOpposition = opposition.replace(/[\\/\0]/g, "").trim();
    const cleanTeam = team.replace(/[\\/\0]/g, "").trim();
    if (!cleanOpposition) throw new Error("opposition is empty after cleaning");
    if (!cleanTeam) throw new Error("team is empty after cleaning");

    const resolvedDate = date ?? nextSaturdayInLondon();

    const templatePath = vaultPath("Templates", "Match.md");
    if (!existsSync(templatePath)) {
      throw new Error("template not found at Templates/Match.md");
    }
    const template = readFileSync(templatePath, "utf8");
    const filled = fillMatchTemplate(template, {
      date: resolvedDate,
      opposition: cleanOpposition,
      team: cleanTeam,
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

const app = express();
app.use(express.json({ limit: "1mb" }));

function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${TOKEN}`) {
    if (PUBLIC_URL) {
      res.setHeader(
        "WWW-Authenticate",
        `Bearer realm="brain-mcp", resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
      );
    }
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, vault: VAULT });
});

if (PUBLIC_URL) {
  app.use(
    createOAuthRouter({
      publicUrl: PUBLIC_URL,
      resourceUrl: `${PUBLIC_URL}/mcp`,
      accessToken: TOKEN,
      storePath: OAUTH_STORE,
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

app.listen(PORT, "127.0.0.1", () => {
  const oauthMode = PUBLIC_URL ? `oauth at ${PUBLIC_URL}` : "oauth disabled (no BRAIN_MCP_PUBLIC_URL)";
  console.log(
    `brain-mcp listening on http://127.0.0.1:${PORT} (vault: ${VAULT}, ${oauthMode})`,
  );
});
