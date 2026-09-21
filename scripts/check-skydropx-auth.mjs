import "dotenv/config";

const baseUrl = process.env.SKYDROPX_BASE_URL?.trim()
  || (process.env.SKYDROPX_MODE === "production"
    ? "https://api-pro.skydropx.com"
    : "https://sb-pro.skydropx.com");

if (process.env.SKYDROPX_MODE !== "sandbox" || process.env.SKYDROPX_MOCK !== "false") {
  console.error("Expected SKYDROPX_MODE=sandbox and SKYDROPX_MOCK=false.");
  process.exit(1);
}

if (!process.env.SKYDROPX_CLIENT_ID?.trim() || !process.env.SKYDROPX_CLIENT_SECRET?.trim()) {
  console.error("Skydropx client credentials are missing.");
  process.exit(1);
}

try {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SKYDROPX_CLIENT_ID,
      client_secret: process.env.SKYDROPX_CLIENT_SECRET,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json().catch(() => ({}));
  const authenticated = response.ok && typeof result.access_token === "string" && result.access_token.length > 0;
  console.log(JSON.stringify({ httpStatus: response.status, authenticated }));
  if (!authenticated) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ networkError: error.cause?.code ?? error.code ?? error.name }));
  process.exitCode = 1;
}
