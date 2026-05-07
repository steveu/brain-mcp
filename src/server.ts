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

function appendWithBlankLine(existing: string, addition: string): string {
  const trimmed = addition.trim();
  if (existing.length === 0) return trimmed + "\n";
  const trailingNewlines = existing.match(/\n*$/)?.[0].length ?? 0;
  const padding = "\n".repeat(Math.max(0, 2 - trailingNewlines));
  return existing + padding + trimmed + "\n";
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
