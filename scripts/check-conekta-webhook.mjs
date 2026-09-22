import "dotenv/config";

const privateKey = process.env.CONEKTA_PRIVATE_KEY?.trim();
if (!privateKey) throw new Error("CONEKTA_PRIVATE_KEY is missing");

const headers = {
  Authorization: `Bearer ${privateKey}`,
  Accept: "application/vnd.conekta-v2.3.0+json",
};

async function get(path) {
  const response = await fetch(`https://api.conekta.io${path}`, { headers });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body.message ?? ""}`);
  return body;
}

const [webhooks, keys] = await Promise.all([
  get("/webhooks?limit=100"),
  get("/webhook_keys?limit=100"),
]);

const configuredKey = process.env.CONEKTA_WEBHOOK_PUBLIC_KEY
  ?.replace(/\\n/g, "\n")
  .replace(/\s/g, "");

console.log(JSON.stringify({
  webhooks: (webhooks.data ?? []).map(({ id, url, active, livemode, subscribed_events }) => ({
    id, url, active, livemode, subscribed_events,
  })),
  webhook_keys: (keys.data ?? []).map(({ id, active, livemode, public_key }) => ({
    id, active, livemode, matches_local_key: Boolean(configuredKey && public_key?.replace(/\s/g, "") === configuredKey),
  })),
}, null, 2));

if (process.argv.includes("--test")) {
  const target = (webhooks.data ?? []).find(({ url }) =>
    url === "https://api-shop-mexico.system-samt.com/api/webhooks/conekta"
  );
  if (!target) throw new Error("Conekta test webhook is not registered");
  const response = await fetch(`https://api.conekta.io/webhooks/${encodeURIComponent(target.id)}/test`, {
    method: "POST",
    headers,
  });
  const body = await response.json().catch(() => ({}));
  console.log(JSON.stringify({
    test_http_status: response.status,
    webhook_id: body.id,
    webhook_status: body.webhook_status,
    delivery_logs: body.webhook_logs?.map(({ last_http_response_status, failed_attempts }) => ({
      last_http_response_status, failed_attempts,
    })),
  }, null, 2));
  if (!response.ok) process.exitCode = 1;
}

if (process.argv.includes("--events")) {
  const events = await get("/events?limit=20");
  console.log(JSON.stringify({
    recent_webhook_events: (events.data ?? [])
      .filter(({ type }) => type === "webhook_ping" || type === "order.paid" || type === "order.pending_payment")
      .map(({ id, type, webhook_status, webhook_logs }) => ({
        id, type, webhook_status,
        delivery_logs: webhook_logs?.map(({ last_http_response_status, failed_attempts }) => ({
          last_http_response_status, failed_attempts,
        })),
      })),
  }, null, 2));
}
