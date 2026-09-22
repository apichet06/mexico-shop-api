import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createApp } from "../dist/app.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
process.env.CONEKTA_WEBHOOK_PUBLIC_KEY = publicKey;

const server = createApp().listen(0);
try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/webhooks/conekta`;
  const payload = JSON.stringify({ type: "webhook_ping", data: { object: {} } });
  const digest = crypto.sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64");

  const send = (body, signature) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(signature ? { DIGEST: signature } : {}) },
    body,
  });

  const valid = await send(payload, digest);
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { received: true });

  const tampered = await send(`${payload} `, digest);
  assert.equal(tampered.status, 401);

  const unsigned = await send(payload);
  assert.equal(unsigned.status, 401);

  console.log("Conekta webhook signature and HTTP response checks passed");
} finally {
  server.close();
}
