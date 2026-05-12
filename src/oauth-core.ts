import { createHash, timingSafeEqual } from "node:crypto";

export type Client = {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  client_name?: string;
  created_at: number;
};

export type AuthCode = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  expires_at: number;
};

export const CODE_TTL_MS = 60_000;

export type ClientStore = {
  get(id: string): Client | undefined;
  add(client: Client): void;
};

export type CodeStore = {
  get(code: string): AuthCode | undefined;
  set(code: string, value: AuthCode): void;
  delete(code: string): boolean;
};

export type CoreDeps = {
  clients: ClientStore;
  codes: CodeStore;
  resource: string;
  accessToken: string;
  now: () => number;
  randomId: (bytes: number) => string;
};

export type RegisterResult =
  | { ok: true; client: Client }
  | { ok: false; error: string; error_description: string };

export function registerClient(deps: CoreDeps, input: unknown): RegisterResult {
  const body = (input ?? {}) as Record<string, unknown>;
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0) {
    return {
      ok: false,
      error: "invalid_redirect_uri",
      error_description: "redirect_uris required",
    };
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isValidRedirectUri(uri)) {
      return {
        ok: false,
        error: "invalid_redirect_uri",
        error_description: `bad redirect_uri: ${String(uri)}`,
      };
    }
  }
  const client: Client = {
    client_id: `client_${deps.randomId(16)}`,
    client_secret: deps.randomId(32),
    redirect_uris: redirectUris as string[],
    client_name: typeof body.client_name === "string" ? body.client_name : undefined,
    created_at: deps.now(),
  };
  deps.clients.add(client);
  return { ok: true, client };
}

export type AuthorizeValidated = {
  client: Client;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  requestedResource: string;
};

export type AuthorizeResult =
  | { ok: true; value: AuthorizeValidated }
  | { ok: false; error: string; error_description: string };

export function validateAuthorizeRequest(deps: CoreDeps, input: unknown): AuthorizeResult {
  const get = (k: string): string | undefined => {
    const v = (input as Record<string, unknown>)?.[k];
    return typeof v === "string" ? v : undefined;
  };
  if (get("response_type") !== "code") {
    return {
      ok: false,
      error: "unsupported_response_type",
      error_description: "response_type must be code",
    };
  }
  const clientId = get("client_id");
  if (!clientId) {
    return { ok: false, error: "invalid_request", error_description: "client_id required" };
  }
  const client = deps.clients.get(clientId);
  if (!client) {
    return { ok: false, error: "invalid_client", error_description: "unknown client_id" };
  }
  const redirectUri = get("redirect_uri");
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return {
      ok: false,
      error: "invalid_request",
      error_description: "redirect_uri must match a registered URI",
    };
  }
  const codeChallenge = get("code_challenge");
  if (!codeChallenge) {
    return {
      ok: false,
      error: "invalid_request",
      error_description: "code_challenge required (PKCE)",
    };
  }
  if (get("code_challenge_method") !== "S256") {
    return {
      ok: false,
      error: "invalid_request",
      error_description: "code_challenge_method must be S256",
    };
  }
  const requestedResource = get("resource");
  if (!isAllowedRequestedResource(requestedResource, deps.resource)) {
    return {
      ok: false,
      error: "invalid_target",
      error_description: `resource must be ${deps.resource}`,
    };
  }
  return {
    ok: true,
    value: {
      client,
      redirectUri,
      codeChallenge,
      state: get("state") ?? "",
      requestedResource: requestedResource ?? deps.resource,
    },
  };
}

export type IssueCodeResult =
  | { ok: true; code: string }
  | { ok: false; error: "invalid_token" };

export function issueCode(
  deps: CoreDeps,
  validated: AuthorizeValidated,
  submittedToken: string,
): IssueCodeResult {
  if (!constantEq(submittedToken, deps.accessToken)) {
    return { ok: false, error: "invalid_token" };
  }
  const code = deps.randomId(24);
  deps.codes.set(code, {
    client_id: validated.client.client_id,
    redirect_uri: validated.redirectUri,
    code_challenge: validated.codeChallenge,
    resource: validated.requestedResource,
    expires_at: deps.now() + CODE_TTL_MS,
  });
  return { ok: true, code };
}

export type TokenResult =
  | { ok: true; access_token: string; token_type: "Bearer" }
  | { ok: false; status: number; error: string; error_description?: string };

export function exchangeCode(deps: CoreDeps, input: unknown): TokenResult {
  const body = (input ?? {}) as Record<string, unknown>;
  if (body.grant_type !== "authorization_code") {
    return { ok: false, status: 400, error: "unsupported_grant_type" };
  }
  const code = typeof body.code === "string" ? body.code : "";
  const stored = deps.codes.get(code);
  if (stored) deps.codes.delete(code);
  if (!stored) {
    return {
      ok: false,
      status: 400,
      error: "invalid_grant",
      error_description: "unknown code",
    };
  }
  if (deps.now() > stored.expires_at) {
    return {
      ok: false,
      status: 400,
      error: "invalid_grant",
      error_description: "code expired",
    };
  }
  const client = deps.clients.get(stored.client_id);
  if (!client) {
    return {
      ok: false,
      status: 400,
      error: "invalid_grant",
      error_description: "client gone",
    };
  }
  if (
    typeof body.client_id !== "string" ||
    body.client_id !== client.client_id ||
    typeof body.client_secret !== "string" ||
    !constantEq(body.client_secret, client.client_secret)
  ) {
    return { ok: false, status: 401, error: "invalid_client" };
  }
  if (body.redirect_uri !== stored.redirect_uri) {
    return {
      ok: false,
      status: 400,
      error: "invalid_grant",
      error_description: "redirect_uri mismatch",
    };
  }
  if (
    typeof body.code_verifier !== "string" ||
    !verifyPkce(stored.code_challenge, body.code_verifier)
  ) {
    return {
      ok: false,
      status: 400,
      error: "invalid_grant",
      error_description: "PKCE failed",
    };
  }
  if (!isAllowedTokenResource(body.resource, stored.resource)) {
    return { ok: false, status: 400, error: "invalid_target" };
  }
  return { ok: true, access_token: deps.accessToken, token_type: "Bearer" };
}

export function verifyPkce(challenge: string, verifier: string): boolean {
  const computed = createHash("sha256").update(verifier).digest().toString("base64url");
  return constantEq(computed, challenge);
}

function constantEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function normResource(r: string): string {
  return r.replace(/\/$/, "");
}

export function isAllowedRequestedResource(
  requestedResource: string | undefined,
  resource: string,
): boolean {
  return (
    requestedResource === undefined ||
    normResource(requestedResource) === normResource(resource)
  );
}

export function isAllowedTokenResource(
  requestedResource: unknown,
  storedResource: string,
): boolean {
  return (
    typeof requestedResource !== "string" ||
    normResource(requestedResource) === normResource(storedResource)
  );
}

export function isValidRedirectUri(uri: string): boolean {
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
