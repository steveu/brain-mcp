import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AuthCode,
  type Client,
  type ClientStore,
  type CodeStore,
  type CoreDeps,
  CODE_TTL_MS,
  exchangeCode,
  issueCode,
  registerClient,
  validateAuthorizeRequest,
  verifyPkce,
} from "../src/oauth-core.js";

const RESOURCE = "https://brain.example.test/mcp";
const ACCESS_TOKEN = "real-token";

function memoryClientStore(seed: Client[] = []): ClientStore {
  const map = new Map(seed.map((c) => [c.client_id, c]));
  return {
    get: (id) => map.get(id),
    add: (c) => {
      map.set(c.client_id, c);
    },
  };
}

function memoryCodeStore(): CodeStore {
  const map = new Map<string, AuthCode>();
  return {
    get: (c) => map.get(c),
    set: (c, v) => {
      map.set(c, v);
    },
    delete: (c) => map.delete(c),
  };
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest().toString("base64url");
}

function makeDeps(overrides: Partial<CoreDeps> = {}): CoreDeps & { time: { value: number } } {
  const time = { value: 1_000_000 };
  let counter = 0;
  const base: CoreDeps = {
    clients: overrides.clients ?? memoryClientStore(),
    codes: overrides.codes ?? memoryCodeStore(),
    resource: overrides.resource ?? RESOURCE,
    accessToken: overrides.accessToken ?? ACCESS_TOKEN,
    now: overrides.now ?? (() => time.value),
    randomId: overrides.randomId ?? ((bytes) => `r${bytes}-${++counter}`),
  };
  return Object.assign(base, { time });
}

const SAMPLE_CLIENT: Client = {
  client_id: "client_abc",
  client_secret: "secret_xyz",
  redirect_uris: ["https://example.test/cb"],
  client_name: "Sample",
  created_at: 0,
};

describe("registerClient", () => {
  it("rejects missing redirect_uris", () => {
    const deps = makeDeps();
    const result = registerClient(deps, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_redirect_uri");
  });

  it("rejects http redirect_uris that aren't localhost", () => {
    const deps = makeDeps();
    const result = registerClient(deps, {
      redirect_uris: ["http://evil.example.test/cb"],
    });
    expect(result.ok).toBe(false);
  });

  it("issues credentials and stores the client", () => {
    const store = memoryClientStore();
    const deps = makeDeps({ clients: store });
    const result = registerClient(deps, {
      redirect_uris: ["https://example.test/cb"],
      client_name: "Test",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.client.redirect_uris).toEqual(["https://example.test/cb"]);
      expect(store.get(result.client.client_id)).toEqual(result.client);
    }
  });
});

describe("validateAuthorizeRequest", () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps({ clients: memoryClientStore([SAMPLE_CLIENT]) });
  });

  it("requires response_type=code", () => {
    const result = validateAuthorizeRequest(deps, { response_type: "token" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("unsupported_response_type");
  });

  it("rejects unknown clients", () => {
    const result = validateAuthorizeRequest(deps, {
      response_type: "code",
      client_id: "client_missing",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_client");
  });

  it("rejects a redirect_uri not in the registered set", () => {
    const result = validateAuthorizeRequest(deps, {
      response_type: "code",
      client_id: SAMPLE_CLIENT.client_id,
      redirect_uri: "https://other.example.test/cb",
      code_challenge: "abc",
      code_challenge_method: "S256",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid_request");
  });

  it("rejects non-S256 PKCE methods", () => {
    const result = validateAuthorizeRequest(deps, {
      response_type: "code",
      client_id: SAMPLE_CLIENT.client_id,
      redirect_uri: SAMPLE_CLIENT.redirect_uris[0],
      code_challenge: "abc",
      code_challenge_method: "plain",
    });
    expect(result.ok).toBe(false);
  });

  it("returns the validated request for a well-formed input", () => {
    const result = validateAuthorizeRequest(deps, {
      response_type: "code",
      client_id: SAMPLE_CLIENT.client_id,
      redirect_uri: SAMPLE_CLIENT.redirect_uris[0],
      code_challenge: "abc",
      code_challenge_method: "S256",
      state: "xyz",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.client.client_id).toBe(SAMPLE_CLIENT.client_id);
      expect(result.value.requestedResource).toBe(RESOURCE);
    }
  });
});

describe("issueCode + exchangeCode", () => {
  const verifier = "the-pkce-verifier-value-1234567890";
  const challenge = s256(verifier);

  function setup() {
    const clients = memoryClientStore([SAMPLE_CLIENT]);
    const codes = memoryCodeStore();
    const deps = makeDeps({ clients, codes });
    const validated = {
      client: SAMPLE_CLIENT,
      redirectUri: SAMPLE_CLIENT.redirect_uris[0],
      codeChallenge: challenge,
      state: "",
      requestedResource: RESOURCE,
    };
    return { deps, codes, validated };
  }

  it("rejects consent with the wrong token", () => {
    const { deps, validated } = setup();
    const result = issueCode(deps, validated, "wrong-token");
    expect(result.ok).toBe(false);
  });

  it("issues a code and lets a matching exchange succeed", () => {
    const { deps, validated } = setup();
    const issued = issueCode(deps, validated, ACCESS_TOKEN);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const result = exchangeCode(deps, {
      grant_type: "authorization_code",
      code: issued.code,
      client_id: SAMPLE_CLIENT.client_id,
      client_secret: SAMPLE_CLIENT.client_secret,
      redirect_uri: SAMPLE_CLIENT.redirect_uris[0],
      code_verifier: verifier,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.access_token).toBe(ACCESS_TOKEN);
  });

  it("rejects an expired code with invalid_grant", () => {
    const { deps, validated } = setup();
    const issued = issueCode(deps, validated, ACCESS_TOKEN);
    if (!issued.ok) throw new Error("setup failed");
    deps.time.value += CODE_TTL_MS + 1;
    const result = exchangeCode(deps, {
      grant_type: "authorization_code",
      code: issued.code,
      client_id: SAMPLE_CLIENT.client_id,
      client_secret: SAMPLE_CLIENT.client_secret,
      redirect_uri: SAMPLE_CLIENT.redirect_uris[0],
      code_verifier: verifier,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_grant");
      expect(result.error_description).toBe("code expired");
    }
  });

  it("rejects PKCE mismatch with invalid_grant", () => {
    const { deps, validated } = setup();
    const issued = issueCode(deps, validated, ACCESS_TOKEN);
    if (!issued.ok) throw new Error("setup failed");
    const result = exchangeCode(deps, {
      grant_type: "authorization_code",
      code: issued.code,
      client_id: SAMPLE_CLIENT.client_id,
      client_secret: SAMPLE_CLIENT.client_secret,
      redirect_uri: SAMPLE_CLIENT.redirect_uris[0],
      code_verifier: "the-wrong-verifier-value-0987654321",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("invalid_grant");
      expect(result.error_description).toBe("PKCE failed");
    }
  });

  it("burns the code on first use (replay returns unknown code)", () => {
    const { deps, validated } = setup();
    const issued = issueCode(deps, validated, ACCESS_TOKEN);
    if (!issued.ok) throw new Error("setup failed");
    const args = {
      grant_type: "authorization_code",
      code: issued.code,
      client_id: SAMPLE_CLIENT.client_id,
      client_secret: SAMPLE_CLIENT.client_secret,
      redirect_uri: SAMPLE_CLIENT.redirect_uris[0],
      code_verifier: verifier,
    };
    const first = exchangeCode(deps, args);
    expect(first.ok).toBe(true);
    const second = exchangeCode(deps, args);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error_description).toBe("unknown code");
  });

  it("rejects a redirect_uri mismatch at token exchange", () => {
    const { deps, validated } = setup();
    const issued = issueCode(deps, validated, ACCESS_TOKEN);
    if (!issued.ok) throw new Error("setup failed");
    const result = exchangeCode(deps, {
      grant_type: "authorization_code",
      code: issued.code,
      client_id: SAMPLE_CLIENT.client_id,
      client_secret: SAMPLE_CLIENT.client_secret,
      redirect_uri: "https://other.example.test/cb",
      code_verifier: verifier,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_description).toBe("redirect_uri mismatch");
  });

  it("rejects a wrong client_secret with invalid_client (401)", () => {
    const { deps, validated } = setup();
    const issued = issueCode(deps, validated, ACCESS_TOKEN);
    if (!issued.ok) throw new Error("setup failed");
    const result = exchangeCode(deps, {
      grant_type: "authorization_code",
      code: issued.code,
      client_id: SAMPLE_CLIENT.client_id,
      client_secret: "wrong-secret",
      redirect_uri: SAMPLE_CLIENT.redirect_uris[0],
      code_verifier: verifier,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toBe("invalid_client");
    }
  });
});

describe("verifyPkce", () => {
  it("matches the documented S256 transform", () => {
    const verifier = "abc123";
    expect(verifyPkce(s256(verifier), verifier)).toBe(true);
    expect(verifyPkce(s256(verifier), "different")).toBe(false);
  });
});
