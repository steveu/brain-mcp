import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { AllowlistMissingError, loadAllowlist } from "./allowlist.js";
import { createServer, type ServerConfig } from "./server.js";

function readConfig(): { config: ServerConfig; port: number } {
  const vault = path.resolve(
    process.env.BRAIN_VAULT ?? path.join(homedir(), "brain", "vault"),
  );
  const token = process.env.BRAIN_MCP_TOKEN;
  const port = Number(process.env.PORT ?? 8765);
  const publicUrl = process.env.BRAIN_MCP_PUBLIC_URL?.replace(/\/$/, "");
  const oauthStorePath =
    process.env.BRAIN_MCP_OAUTH_STORE ??
    path.join(homedir(), "data", "brain-mcp", "oauth.json");
  const allowlistPath =
    process.env.BRAIN_MCP_ALLOWLIST ?? path.join(path.dirname(vault), "allowlist");
  const auditLogPath =
    process.env.BRAIN_MCP_AUDIT_LOG ?? path.join(homedir(), "data", "brain-mcp", "audit.log");

  if (!token) {
    console.error("BRAIN_MCP_TOKEN is required");
    process.exit(1);
  }
  if (!existsSync(vault)) {
    console.error(`vault not found at ${vault}`);
    process.exit(1);
  }
  // Fail closed at startup: missing allowlist must not silently widen exposure.
  try {
    loadAllowlist(vault, allowlistPath);
  } catch (err) {
    if (err instanceof AllowlistMissingError) {
      console.error(err.message);
    } else {
      console.error(`failed to load allowlist at ${allowlistPath}: ${(err as Error).message}`);
    }
    process.exit(1);
  }

  return {
    config: { vault, token, publicUrl, oauthStorePath, allowlistPath, auditLogPath },
    port,
  };
}

function main(): void {
  const { config, port } = readConfig();
  const app = createServer(config);
  app.listen(port, "127.0.0.1", () => {
    const oauthMode = config.publicUrl
      ? `oauth at ${config.publicUrl}`
      : "oauth disabled (no BRAIN_MCP_PUBLIC_URL)";
    console.log(
      `brain-mcp listening on http://127.0.0.1:${port} (vault: ${config.vault}, allowlist: ${config.allowlistPath}, ${oauthMode})`,
    );
  });
}

main();
