import { describe, expect, it } from "vitest";
import { isAllowedRequestedResource, isAllowedTokenResource } from "../src/oauth.js";

describe("OAuth resource handling", () => {
  const resource = "https://brain.example.test/mcp";

  it("defaults a missing authorize resource to the server MCP resource", () => {
    expect(isAllowedRequestedResource(undefined, resource)).toBe(true);
  });

  it("accepts matching resources with or without trailing slashes", () => {
    expect(isAllowedRequestedResource("https://brain.example.test/mcp/", resource)).toBe(true);
    expect(isAllowedTokenResource("https://brain.example.test/mcp/", resource)).toBe(true);
  });

  it("rejects wrong resources", () => {
    expect(isAllowedRequestedResource("https://other.example.test/mcp", resource)).toBe(false);
    expect(isAllowedTokenResource("https://other.example.test/mcp", resource)).toBe(false);
  });

  it("allows token requests to omit resource after authorize has fixed the target", () => {
    expect(isAllowedTokenResource(undefined, resource)).toBe(true);
  });
});
