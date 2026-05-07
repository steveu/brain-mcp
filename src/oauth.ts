import express, { Router, type Response } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type Client = {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  client_name?: string;
  created_at: number;
};

type AuthCode = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  expires_at: number;
};

const CODE_TTL_MS = 60_000;

export type OAuthDeps = {
  publicUrl: string;
  resourceUrl: string;
  accessToken: string;
  storePath: string;
};

export function createOAuthRouter(deps: OAuthDeps): Router {
  const router = Router();
  const issuer = deps.publicUrl.replace(/\/$/, "");
  const resource = deps.resourceUrl;
  const clients = loadClients(deps.storePath);
  const codes = new Map<string, AuthCode>();
  const formBody = express.urlencoded({ extended: false });

  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    });
  });

  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
        "none",
      ],
    });
  });

  router.post("/register", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (redirectUris.length === 0) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris required",
      });
      return;
    }
    for (const uri of redirectUris) {
      if (typeof uri !== "string" || !isValidRedirectUri(uri)) {
        res.status(400).json({
          error: "invalid_redirect_uri",
          error_description: `bad redirect_uri: ${String(uri)}`,
        });
        return;
      }
    }
    const client: Client = {
      client_id: `client_${randomB64Url(16)}`,
      client_secret: randomB64Url(32),
      redirect_uris: redirectUris as string[],
      client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      created_at: Date.now(),
    };
    clients.set(client.client_id, client);
    saveClients(deps.storePath, clients);
    res.status(201).json({
      client_id: client.client_id,
      client_secret: client.client_secret,
      client_id_issued_at: Math.floor(client.created_at / 1000),
      redirect_uris: client.redirect_uris,
      client_name: client.client_name,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    });
  });

  router.get("/authorize", (req, res) => {
    const parsed = parseAuthorizeParams(req.query);
    if (!parsed.ok) {
      replyAuthorizeError(res, req.query, parsed.error, parsed.description);
      return;
    }
    res.type("text/html").send(renderAuthorizePage(req.query));
  });

  router.post("/authorize", formBody, (req, res) => {
    const merged = { ...req.query, ...req.body };
    const parsed = parseAuthorizeParams(merged);
    if (!parsed.ok) {
      replyAuthorizeError(res, merged, parsed.error, parsed.description);
      return;
    }
    const submitted = typeof req.body?.brain_token === "string" ? req.body.brain_token : "";
    if (!constantEq(submitted, deps.accessToken)) {
      res
        .status(401)
        .type("text/html")
        .send(renderAuthorizePage(merged, "Wrong token. Try again."));
      return;
    }
    const code = randomB64Url(24);
    codes.set(code, {
      client_id: parsed.value.client.client_id,
      redirect_uri: parsed.value.redirectUri,
      code_challenge: parsed.value.codeChallenge,
      resource: parsed.value.requestedResource,
      expires_at: Date.now() + CODE_TTL_MS,
    });
    const target = new URL(parsed.value.redirectUri);
    target.searchParams.set("code", code);
    if (parsed.value.state) target.searchParams.set("state", parsed.value.state);
    res.redirect(target.toString());
  });

  router.post("/token", formBody, (req, res) => {
    const basic = parseBasicAuth(req.headers.authorization);
    const body: Record<string, unknown> = { ...(req.body ?? {}), ...basic };
    if (body.grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }
    const code = typeof body.code === "string" ? body.code : "";
    const stored = codes.get(code);
    if (stored) codes.delete(code);
    if (!stored) {
      res.status(400).json({ error: "invalid_grant", error_description: "unknown code" });
      return;
    }
    if (Date.now() > stored.expires_at) {
      res.status(400).json({ error: "invalid_grant", error_description: "code expired" });
      return;
    }
    const client = clients.get(stored.client_id);
    if (!client) {
      res.status(400).json({ error: "invalid_grant", error_description: "client gone" });
      return;
    }
    if (
      typeof body.client_id !== "string" ||
      body.client_id !== client.client_id ||
      typeof body.client_secret !== "string" ||
      !constantEq(body.client_secret, client.client_secret)
    ) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }
    if (body.redirect_uri !== stored.redirect_uri) {
      res
        .status(400)
        .json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }
    if (
      typeof body.code_verifier !== "string" ||
      !pkceVerify(stored.code_challenge, body.code_verifier)
    ) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE failed" });
      return;
    }
    if (
      typeof body.resource !== "string" ||
      normResource(body.resource) !== normResource(stored.resource)
    ) {
      res.status(400).json({ error: "invalid_target" });
      return;
    }
    res.json({
      access_token: deps.accessToken,
      token_type: "Bearer",
    });
  });

  type AuthorizeOk = {
    ok: true;
    value: {
      client: Client;
      redirectUri: string;
      codeChallenge: string;
      state: string;
      requestedResource: string;
    };
  };
  type AuthorizeErr = { ok: false; error: string; description: string };
  type AuthorizeResult = AuthorizeOk | AuthorizeErr;

  function parseAuthorizeParams(input: unknown): AuthorizeResult {
    const get = (k: string): string | undefined => {
      const v = (input as Record<string, unknown>)?.[k];
      return typeof v === "string" ? v : undefined;
    };
    if (get("response_type") !== "code") {
      return { ok: false, error: "unsupported_response_type", description: "response_type must be code" };
    }
    const clientId = get("client_id");
    if (!clientId) return { ok: false, error: "invalid_request", description: "client_id required" };
    const client = clients.get(clientId);
    if (!client) return { ok: false, error: "invalid_client", description: "unknown client_id" };
    const redirectUri = get("redirect_uri");
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return { ok: false, error: "invalid_request", description: "redirect_uri must match a registered URI" };
    }
    const codeChallenge = get("code_challenge");
    if (!codeChallenge) {
      return { ok: false, error: "invalid_request", description: "code_challenge required (PKCE)" };
    }
    if (get("code_challenge_method") !== "S256") {
      return { ok: false, error: "invalid_request", description: "code_challenge_method must be S256" };
    }
    const requestedResource = get("resource");
    if (!requestedResource || normResource(requestedResource) !== normResource(resource)) {
      return { ok: false, error: "invalid_target", description: `resource must be ${resource}` };
    }
    return {
      ok: true,
      value: {
        client,
        redirectUri,
        codeChallenge,
        state: get("state") ?? "",
        requestedResource,
      },
    };
  }

  function replyAuthorizeError(
    res: Response,
    input: unknown,
    error: string,
    description: string,
  ): void {
    const get = (k: string): string | undefined => {
      const v = (input as Record<string, unknown>)?.[k];
      return typeof v === "string" ? v : undefined;
    };
    const redirectUri = get("redirect_uri");
    const clientId = get("client_id");
    const client = clientId ? clients.get(clientId) : undefined;
    if (
      redirectUri &&
      client &&
      client.redirect_uris.includes(redirectUri) &&
      isValidRedirectUri(redirectUri)
    ) {
      const target = new URL(redirectUri);
      target.searchParams.set("error", error);
      target.searchParams.set("error_description", description);
      const state = get("state");
      if (state) target.searchParams.set("state", state);
      res.redirect(target.toString());
      return;
    }
    res.status(400).json({ error, error_description: description });
  }

  return router;
}

function normResource(r: string): string {
  return r.replace(/\/$/, "");
}

function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function pkceVerify(challenge: string, verifier: string): boolean {
  const computed = createHash("sha256").update(verifier).digest().toString("base64url");
  return constantEq(computed, challenge);
}

function constantEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function randomB64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function parseBasicAuth(header: string | undefined): {
  client_id?: string;
  client_secret?: string;
} {
  if (!header || !header.startsWith("Basic ")) return {};
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return {};
    return {
      client_id: decodeURIComponent(decoded.slice(0, idx)),
      client_secret: decodeURIComponent(decoded.slice(idx + 1)),
    };
  } catch {
    return {};
  }
}

function loadClients(storePath: string): Map<string, Client> {
  if (!existsSync(storePath)) return new Map();
  try {
    const data = JSON.parse(readFileSync(storePath, "utf8")) as { clients?: Client[] };
    return new Map((data.clients ?? []).map((c) => [c.client_id, c]));
  } catch {
    return new Map();
  }
}

function saveClients(storePath: string, clients: Map<string, Client>): void {
  const dir = path.dirname(storePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const data = { clients: Array.from(clients.values()) };
  writeFileSync(storePath, JSON.stringify(data, null, 2), "utf8");
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderAuthorizePage(input: unknown, errorMsg?: string): string {
  const get = (k: string): string | undefined => {
    const v = (input as Record<string, unknown>)?.[k];
    return typeof v === "string" ? v : undefined;
  };
  const fields = [
    "response_type",
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "state",
    "resource",
    "scope",
  ];
  const hidden = fields
    .map((f) => {
      const v = get(f);
      return v === undefined
        ? ""
        : `<input type="hidden" name="${htmlEscape(f)}" value="${htmlEscape(v)}">`;
    })
    .filter(Boolean)
    .join("\n");
  const clientName = get("client_id") ?? "an unknown client";
  const error = errorMsg ? `<p class="err">${htmlEscape(errorMsg)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorize — brain-mcp</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.4; }
  h1 { font-size: 1.25rem; }
  label { display: block; margin: 1rem 0 0.25rem; font-size: 0.9rem; }
  input[type=password] { width: 100%; padding: 0.5rem; font-family: ui-monospace, monospace; font-size: 0.95rem; box-sizing: border-box; }
  button { margin-top: 1rem; padding: 0.5rem 1rem; }
  .err { color: #b00020; }
  code { font-family: ui-monospace, monospace; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>Authorize <code>${htmlEscape(clientName)}</code></h1>
<p>Issues an access token for the <code>brain-mcp</code> server. Paste your <code>BRAIN_MCP_TOKEN</code> to confirm.</p>
${error}
<form method="post" action="/authorize">
${hidden}
<label for="brain_token">BRAIN_MCP_TOKEN</label>
<input type="password" id="brain_token" name="brain_token" autocomplete="off" autofocus>
<button type="submit">Authorize</button>
</form>
</body>
</html>`;
}
