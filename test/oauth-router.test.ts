import express from "express";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOAuthRouter } from "../src/oauth.js";

type Captured = {
  level: string;
  msg?: string;
  event?: string;
  [key: string]: unknown;
};

function capturingLogger(captured: Captured[]) {
  const stream = {
    write(chunk: string) {
      const trimmed = chunk.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const levels: Record<number, string> = {
          10: "trace",
          20: "debug",
          30: "info",
          40: "warn",
          50: "error",
          60: "fatal",
        };
        const numericLevel = typeof parsed.level === "number" ? parsed.level : 30;
        captured.push({
          ...parsed,
          level: levels[numericLevel] ?? String(numericLevel),
        } as Captured);
      } catch {
        /* ignore */
      }
    },
  };
  return pino({ level: "trace" }, stream);
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest().toString("base64url");
}

async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* already closed */
  }
}

describe("OAuth router /token auth-failure logging", () => {
  let storeDir: string;
  let storePath: string;
  const captured: Captured[] = [];

  beforeEach(() => {
    captured.length = 0;
    storeDir = mkdtempSync(path.join(tmpdir(), "brain-mcp-oauth-router-"));
    storePath = path.join(storeDir, "oauth.json");
  });

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("emits an auth_failure line on a 401 from /token with no client secret in the log", async () => {
    const logger = capturingLogger(captured);
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(
      createOAuthRouter({
        publicUrl: "https://brain.example.test",
        resourceUrl: "https://brain.example.test/mcp",
        accessToken: "static-token",
        storePath,
        logger,
      }),
    );

    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    // 1. Register a client.
    const redirectUri = "https://client.example.test/cb";
    const registerRes = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "test client",
        redirect_uris: [redirectUri],
      }),
    });
    expect(registerRes.status).toBe(201);
    const registered = (await registerRes.json()) as {
      client_id: string;
      client_secret: string;
    };

    // 2. Drive an authorize flow to obtain an issued code via POST /authorize.
    const verifier = randomBytes(32).toString("base64url");
    const challenge = s256(verifier);
    const authorizeRes = await fetch(`${base}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        state: "xyz",
        code_challenge: challenge,
        code_challenge_method: "S256",
        brain_token: "static-token",
      }),
      redirect: "manual",
    });
    expect([302, 303]).toContain(authorizeRes.status);
    const location = authorizeRes.headers.get("location") ?? "";
    await drain(authorizeRes);
    const code = new URL(location).searchParams.get("code") ?? "";
    expect(code.length).toBeGreaterThan(0);

    // 3. Hit /token with the right code but the wrong client_secret to drive
    // the 401 invalid_client branch.
    const wrongSecret = "definitely-not-the-real-secret-9876";
    const tokenRes = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: registered.client_id,
        client_secret: wrongSecret,
        code_verifier: verifier,
      }),
    });
    expect(tokenRes.status).toBe(401);
    await drain(tokenRes);

    const authFailures = captured.filter((line) => line.event === "auth_failure");
    expect(authFailures).toHaveLength(1);
    expect(authFailures[0]!.path).toBe("/token");
    expect(authFailures[0]!.reason).toBe("token_invalid_client");

    // The real and wrong secrets must never appear in any captured line.
    const serialised = JSON.stringify(captured);
    expect(serialised).not.toContain(wrongSecret);
    expect(serialised).not.toContain(registered.client_secret);

    await new Promise<void>((res, rej) =>
      server.close((err) => (err ? rej(err) : res())),
    );
  });
});

