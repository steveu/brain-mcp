import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response, type NextFunction, type Express } from "express";
import { loadAllowlist } from "./allowlist.js";
import type { AuditSink } from "./audit.js";
import { createOAuthRouter } from "./oauth.js";
import { readTools } from "./tools/read.js";
import { writeTools } from "./tools/write.js";

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

  for (const tool of writeTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args) => {
        const text = tool.run({ vault }, args);
        return { content: [{ type: "text", text }] };
      },
    );
  }

  for (const tool of readTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args) => {
        const text = tool.run({ allowlist: readAllowlistOrThrow, audit }, args);
        return { content: [{ type: "text", text }] };
      },
    );
  }

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
