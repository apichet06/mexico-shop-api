import "dotenv/config";

const url = process.argv[2];
if (!url || !/^https:\/\//i.test(url)) {
  throw new Error("Usage: node scripts/create-conekta-webhook.mjs https://your-api.example/api/webhooks/conekta");
}

const privateKey = process.env.CONEKTA_PRIVATE_KEY?.trim();
const localPublicKey = process.env.CONEKTA_WEBHOOK_PUBLIC_KEY?.replace(/\\n/g, "\n").replace(/\s/g, "");
if (!privateKey || !localPublicKey) throw new Error("Conekta API and webhook public keys are required");

const headers = {
  Authorization: `Bearer ${privateKey}`,
  Accept: "application/vnd.conekta-v2.3.0+json",
  "Content-Type": "application/json",
};

async function conekta(path, init = {}) {
  const response = await fetch(`https://api.conekta.io${path}`, { ...init, headers });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body.message ?? ""}`);
  return body;
}

const [keys, webhooks] = await Promise.all([
  conekta("/webhook_keys?limit=100"),
  conekta("/webhooks?limit=100"),
]);
if (!(keys.data ?? []).some(key => key.active && key.livemode === false && key.public_key?.replace(/\s/g, "") === localPublicKey)) {
  throw new Error("The active Conekta test webhook key does not match CONEKTA_WEBHOOK_PUBLIC_KEY");
}

const existing = (webhooks.data ?? []).find(webhook => webhook.url === url);
if (existing) {
  console.log(JSON.stringify({ result: "already_exists", id: existing.id, url: existing.url, events: existing.subscribed_events }));
  process.exit(0);
}

const probe = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ type: "webhook_ping" }),
});
if (probe.status !== 401) {
  throw new Error(`Webhook endpoint returned HTTP ${probe.status} to an unsigned request; expected 401. Deploy the API first.`);
}

const created = await conekta("/webhooks", {
  method: "POST",
  body: JSON.stringify({
    url,
    subscribed_events: ["order.paid", "order.pending_payment", "webhook_ping"],
  }),
});
console.log(JSON.stringify({ result: "created", id: created.id, url: created.url, events: created.subscribed_events }));
