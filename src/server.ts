import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response, type NextFunction, type Express } from "express";
import { accessSync, constants as fsConstants } from "node:fs";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { loadAllowlist } from "./allowlist.js";
import type { AuditSink } from "./audit.js";
import type { AppLogger } from "./logger.js";
import { silentLogger } from "./logger.js";
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
  /**
   * Application logger. Defaults to a silent pino instance — production code
   * should pass the rotating-file logger from `createAppLogger`.
   */
  logger?: AppLogger;
};

export function createServer(config: ServerConfig): Express {
  const { vault, token, publicUrl, oauthStorePath, allowlistPath, audit } = config;
  const logger = config.logger ?? silentLogger();

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
        const started = Date.now();
        try {
          const text = tool.run({ vault }, args);
          logger.info(
            {
              event: "tool_call",
              tool: tool.name,
              args_summary: summariseToolArgs(tool.name, args),
              outcome: "ok",
              duration_ms: Date.now() - started,
            },
            "tool call completed",
          );
          return { content: [{ type: "text", text }] };
        } catch (err) {
          logger.warn(
            {
              event: "tool_call",
              tool: tool.name,
              args_summary: summariseToolArgs(tool.name, args),
              outcome: "error",
              duration_ms: Date.now() - started,
              err_message: (err as Error).message,
            },
            "tool call failed",
          );
          throw err;
        }
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
        const started = Date.now();
        try {
          const text = tool.run({ allowlist: readAllowlistOrThrow, audit }, args);
          logger.info(
            {
              event: "tool_call",
              tool: tool.name,
              args_summary: summariseToolArgs(tool.name, args),
              outcome: "ok",
              duration_ms: Date.now() - started,
            },
            "tool call completed",
          );
          return { content: [{ type: "text", text }] };
        } catch (err) {
          logger.warn(
            {
              event: "tool_call",
              tool: tool.name,
              args_summary: summariseToolArgs(tool.name, args),
              outcome: "error",
              duration_ms: Date.now() - started,
              err_message: (err as Error).message,
            },
            "tool call failed",
          );
          throw err;
        }
      },
    );
  }

  const app = express();

  // helmet() defaults are fine for the OAuth HTML pages — they self-contain
  // their styles and load no third-party assets.
  app.use(helmet());

  // One JSON line per HTTP request: method, path, status, duration, request id.
  // `req.id` is also exposed on the request object for downstream handlers.
  app.use(
    pinoHttp({
      logger,
      // Keep response time on the standard `responseTime` field.
      customSuccessMessage: () => "http request",
      customErrorMessage: () => "http request errored",
      // Redact again at the http-log layer to ensure no auth header leaks via
      // `req.headers` even if upstream redact paths change. Strip the query
      // string from the logged path — request URLs can carry tokens
      // (`?brain_token=...`, OAuth `code` values, etc.) and the issue
      // requires we never log them.
      serializers: {
        req(req: Request & { id?: string | number }) {
          const rawUrl = typeof req.url === "string" ? req.url : "";
          const qIndex = rawUrl.indexOf("?");
          const pathOnly = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
          return {
            id: req.id,
            method: req.method,
            path: pathOnly,
            remoteAddress: req.ip,
          };
        },
        res(res) {
          return { statusCode: res.statusCode };
        },
      },
    }),
  );

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
      const reason = !auth
        ? "missing_bearer"
        : auth.startsWith("Bearer ")
        ? "wrong_bearer"
        : "malformed_authorization";
      logger.warn(
        {
          event: "auth_failure",
          path: pathOnly(req.originalUrl ?? req.url),
          source_ip: req.ip,
          reason,
        },
        "auth failure",
      );
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  }

  app.get("/healthz", (_req, res) => {
    // Liveness: process is up and responding. Does not inspect the vault.
    res.json({ ok: true, vault });
  });

  app.get("/readyz", (_req, res) => {
    try {
      accessSync(vault, fsConstants.W_OK);
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, reason: "vault_not_writable" });
    }
  });

  if (publicUrl) {
    app.use(
      createOAuthRouter({
        publicUrl,
        resourceUrl: `${publicUrl}/mcp`,
        accessToken: token,
        storePath: oauthStorePath,
        logger,
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

/**
 * Strip a query string from a request URL — request URLs can carry secrets
 * in query parameters (e.g. `?brain_token=...`, OAuth `code` values), which
 * the issue requires we never log.
 */
function pathOnly(url: string | undefined): string {
  if (typeof url !== "string") return "";
  const q = url.indexOf("?");
  return q >= 0 ? url.slice(0, q) : url;
}

/**
 * Reduce write-tool argument shapes to something safe to log: lengths and
 * non-sensitive identifiers only. The full thought body / recipe body never
 * appears in structured logs.
 */
function summariseToolArgs(toolName: string, args: unknown): Record<string, unknown> {
  if (toolName === "capture") {
    const thought =
      typeof (args as { thought?: unknown })?.thought === "string"
        ? ((args as { thought: string }).thought)
        : "";
    return { thought_length: thought.length };
  }
  if (toolName === "add_recipe") {
    const a = args as { title?: unknown; body?: unknown };
    return {
      title: typeof a?.title === "string" ? a.title : undefined,
      body_length: typeof a?.body === "string" ? a.body.length : 0,
    };
  }
  if (toolName === "create_match") {
    const a = args as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a ?? {})) {
      summary[k] = typeof v === "string" ? `len:${v.length}` : typeof v;
    }
    return summary;
  }
  // Read tools — surface only top-level argument keys, never values.
  if (args && typeof args === "object") {
    return { keys: Object.keys(args as Record<string, unknown>) };
  }
  return {};
}
