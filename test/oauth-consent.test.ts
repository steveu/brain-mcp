import { describe, expect, it } from "vitest";
import { renderAuthorizePage } from "../src/oauth-consent.js";

const PAYLOAD = "<script>alert(1)</script>";
const ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt;";

const INJECTED_FIELDS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "resource",
  "scope",
] as const;

describe("renderAuthorizePage HTML escaping", () => {
  it("escapes every injected query-string field", () => {
    const input: Record<string, string> = {};
    for (const f of INJECTED_FIELDS) input[f] = PAYLOAD;

    const html = renderAuthorizePage(input);

    expect(html).not.toContain("<script>alert(1)</script>");
    // Each field's value must appear in escaped form in the rendered hidden inputs.
    for (const f of INJECTED_FIELDS) {
      expect(html).toContain(`name="${f}" value="${ESCAPED}"`);
    }
  });

  it("escapes client_id when used as the displayed client name", () => {
    const html = renderAuthorizePage({ client_id: PAYLOAD });

    expect(html).not.toContain("<script>alert(1)</script>");
    // The <h1> renders the client_id inside a <code> block; the escaped form must be present.
    expect(html).toContain(`<code>${ESCAPED}</code>`);
  });

  it("escapes the errorMsg argument", () => {
    const html = renderAuthorizePage({}, PAYLOAD);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain(`<p class="err">${ESCAPED}</p>`);
  });

  it("does not emit a raw <script> tag even when every field and errorMsg carry the payload", () => {
    const input: Record<string, string> = {};
    for (const f of INJECTED_FIELDS) input[f] = PAYLOAD;
    const html = renderAuthorizePage(input, PAYLOAD);

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</script>");
    expect(html).not.toContain("alert(1)</");
  });
});
