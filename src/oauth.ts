import express, { Router, type Response } from "express";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type AuthCode,
  type Client,
  type ClientStore,
  type CodeStore,
  type CoreDeps,
  exchangeCode,
  isValidRedirectUri,
  issueCode,
  registerClient,
  validateAuthorizeRequest,
} from "./oauth-core.js";
import { renderAuthorizePage } from "./oauth-consent.js";

export {
  isAllowedRequestedResource,
  isAllowedTokenResource,
} from "./oauth-core.js";

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

  const clientStore = createFileClientStore(deps.storePath);
  const codeStore = createMemoryCodeStore();
  const core: CoreDeps = {
    clients: clientStore,
    codes: codeStore,
    resource,
    accessToken: deps.accessToken,
    now: () => Date.now(),
    randomId: (bytes) => randomBytes(bytes).toString("base64url"),
  };

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
    const result = registerClient(core, req.body);
    if (!result.ok) {
      res.status(400).json({ error: result.error, error_description: result.error_description });
      return;
    }
    const client = result.client;
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
    const parsed = validateAuthorizeRequest(core, req.query);
    if (!parsed.ok) {
      replyAuthorizeError(res, req.query, parsed.error, parsed.error_description);
      return;
    }
    res.type("text/html").send(renderAuthorizePage(req.query));
  });

  router.post("/authorize", formBody, (req, res) => {
    const merged = { ...req.query, ...req.body };
    const parsed = validateAuthorizeRequest(core, merged);
    if (!parsed.ok) {
      replyAuthorizeError(res, merged, parsed.error, parsed.error_description);
      return;
    }
    const submitted = typeof req.body?.brain_token === "string" ? req.body.brain_token : "";
    const issued = issueCode(core, parsed.value, submitted);
    if (!issued.ok) {
      res
        .status(401)
        .type("text/html")
        .send(renderAuthorizePage(merged, "Wrong token. Try again."));
      return;
    }
    const target = new URL(parsed.value.redirectUri);
    target.searchParams.set("code", issued.code);
    if (parsed.value.state) target.searchParams.set("state", parsed.value.state);
    res.redirect(target.toString());
  });

  router.post("/token", formBody, (req, res) => {
    const basic = parseBasicAuth(req.headers.authorization);
    const merged: Record<string, unknown> = { ...(req.body ?? {}), ...basic };
    const result = exchangeCode(core, merged);
    if (!result.ok) {
      const payload: Record<string, string> = { error: result.error };
      if (result.error_description) payload.error_description = result.error_description;
      res.status(result.status).json(payload);
      return;
    }
    res.json({ access_token: result.access_token, token_type: result.token_type });
  });

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
    const client = clientId ? clientStore.get(clientId) : undefined;
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

function createFileClientStore(storePath: string): ClientStore {
  const map = loadClients(storePath);
  return {
    get: (id) => map.get(id),
    add: (client) => {
      map.set(client.client_id, client);
      saveClients(storePath, map);
    },
  };
}

function createMemoryCodeStore(): CodeStore {
  const map = new Map<string, AuthCode>();
  return {
    get: (code) => map.get(code),
    set: (code, value) => {
      map.set(code, value);
    },
    delete: (code) => map.delete(code),
  };
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
