function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderAuthorizePage(input: unknown, errorMsg?: string): string {
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
