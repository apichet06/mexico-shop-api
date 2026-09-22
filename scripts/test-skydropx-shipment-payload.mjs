import assert from "node:assert/strict";
import { createSkydropxShipment, getSkydropxShipmentLabel, getSkydropxTracking } from "../dist/modules/shipping/providers/skydropx.js";

process.env.SKYDROPX_MOCK = "false";
process.env.SKYDROPX_MODE = "sandbox";
process.env.SKYDROPX_BASE_URL = "https://sandbox.example.invalid";
process.env.SKYDROPX_CLIENT_ID = "test-id";
process.env.SKYDROPX_CLIENT_SECRET = "test-secret";
process.env.SKYDROPX_CONSIGNMENT_NOTE = "49211606";
process.env.SKYDROPX_PACKAGE_TYPE = "4G";

let shipmentPayload;
let delayedTracking = false;
let validationError = false;
let delayedLabel = false;
let labelPolls = 0;
let trackingHasEvents = false;
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname;
  if (path === "/api/v1/oauth/token") return Response.json({ access_token: "test-token", expires_in: 3600 });
  if (path === "/api/v1/shipments/tracking") {
    if (!trackingHasEvents) return Response.json({ error: "No se encontró eventos de rastreo para ese número de guía." }, { status: 404 });
    return Response.json({ data: [{ id: "event-1", attributes: { status: "picked_up", date: "2026-09-22T03:00:00Z", description: "Paquete recogido" } }] });
  }
  if (path === "/api/v2/quotations") return Response.json({ id: "quote-1", is_completed: true, rates: [{ id: "rate-1", provider_name: "dhl", total: 100, success: true }] });
  if (path === "/api/v2/shipments") {
    shipmentPayload = JSON.parse(init.body);
    if (validationError) return Response.json({ errors: { address_from: { reference: ["no puede estar en blanco"] } } }, { status: 422 });
    if (delayedTracking) return Response.json({ data: [{ id: "shipment-2", attributes: { workflow_status: "processing" } }] }, { status: 202 });
    if (delayedLabel) return Response.json({ data: [{ id: "shipment-3", attributes: { workflow_status: "in_progress", master_tracking_number: "TRACK-3" } }] }, { status: 202 });
    return Response.json({
      data: [{ id: "shipment-1", attributes: { workflow_status: "created" } }],
      included: [{ type: "packages", attributes: { tracking_number: "TRACK-1", label_url: "https://example.invalid/label", tracking_url_provider: "https://example.invalid/track" } }],
    }, { status: 202 });
  }
  if (path === "/api/v1/shipments/shipment-2") return Response.json({
    data: { id: "shipment-2", attributes: { workflow_status: "created" } },
    included: [{ type: "packages", attributes: { tracking_number: "TRACK-2", label_url: "https://example.invalid/label-2" } }],
  });
  if (path === "/api/v1/shipments/shipment-3") {
    labelPolls += 1;
    return Response.json({
      data: { id: "shipment-3", attributes: { workflow_status: labelPolls > 1 ? "success" : "in_progress", master_tracking_number: "TRACK-3" } },
      included: [{ type: "package", attributes: { tracking_number: "TRACK-3", label_url: labelPolls > 1 ? "https://example.invalid/label-3" : null } }],
    });
  }
  throw new Error(`Unexpected request: ${path}`);
};

const address = { name: "Test", address: "Avenida de Prueba 123, Colonia Monterrey Centro", province: "Nuevo León", state: "Monterrey", district: "Centro", postcode: "64000", tel: "8111111111" };
const result = await createSkydropxShipment({
  email: "test@example.invalid",
  orderNo: "TEST-1",
  courierCode: "dhl",
  from: address,
  to: address,
  parcel: { name: "Guantes de golf", weight: 10, length: 15, width: 5, height: 17 },
  products: [{ product_code: "SKU-1", name: "Guantes de golf", price: 514, amount: 1, weight: 10 }],
  declaredValue: 514,
});

assert.equal(shipmentPayload.shipment.packages[0].consignment_note, "49211606");
assert.equal(shipmentPayload.shipment.packages[0].package_type, "4G");
assert.equal(shipmentPayload.shipment.address_from.street1, address.address);
assert.equal(shipmentPayload.shipment.address_to.street1, address.address);
assert.ok(shipmentPayload.shipment.address_from.reference.length > 0 && shipmentPayload.shipment.address_from.reference.length <= 30);
assert.ok(shipmentPayload.shipment.address_to.reference.length > 0 && shipmentPayload.shipment.address_to.reference.length <= 30);
assert.equal(result.providerShipmentId, "shipment-1");
assert.equal(result.courierTrackingCode, "TRACK-1");
assert.equal(result.labelUrl, "https://example.invalid/label");
delayedTracking = true;
const delayedResult = await createSkydropxShipment({
  email: "test@example.invalid",
  orderNo: "TEST-2",
  courierCode: "dhl",
  from: address,
  to: address,
  parcel: { name: "Guantes de golf", weight: 10, length: 15, width: 5, height: 17 },
  products: [{ product_code: "SKU-1", name: "Guantes de golf", price: 514, amount: 1, weight: 10 }],
  declaredValue: 514,
});
assert.equal(delayedResult.providerShipmentId, "shipment-2");
assert.equal(delayedResult.courierTrackingCode, "TRACK-2");
delayedTracking = false;
delayedLabel = true;
const labelResult = await createSkydropxShipment({
  email: "test@example.invalid",
  orderNo: "TEST-3",
  courierCode: "dhl",
  from: address,
  to: address,
  parcel: { name: "Guantes de golf", weight: 10, length: 15, width: 5, height: 17 },
  products: [{ product_code: "SKU-1", name: "Guantes de golf", price: 514, amount: 1, weight: 10 }],
  declaredValue: 514,
});
assert.equal(labelResult.labelUrl, "https://example.invalid/label-3");
assert.equal(await getSkydropxShipmentLabel("shipment-3"), "https://example.invalid/label-3");
validationError = true;
await assert.rejects(
  createSkydropxShipment({
    email: "test@example.invalid",
    orderNo: "TEST-3",
    courierCode: "dhl",
    from: address,
    to: address,
    parcel: { name: "Guantes de golf", weight: 10, length: 15, width: 5, height: 17 },
    products: [{ product_code: "SKU-1", name: "Guantes de golf", price: 514, amount: 1, weight: 10 }],
    declaredValue: 514,
  }),
  (error) => error.message.includes("address_from.reference: no puede estar en blanco"),
);
const noEvents = await getSkydropxTracking("TRACK-3", "dhl");
assert.equal(noEvents.states.length, 0);
assert.equal(noEvents.orderStatus, null);
trackingHasEvents = true;
const withEvents = await getSkydropxTracking("TRACK-3", "dhl");
assert.equal(withEvents.states.length, 1);
assert.equal(withEvents.states[0].status, "picked_up");
assert.equal(withEvents.states[0].datetime, "2026-09-22T03:00:00Z");
console.log("Skydropx shipment and tracking parsing passed.");
