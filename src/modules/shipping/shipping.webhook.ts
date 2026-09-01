import crypto from "crypto";
import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import { ensureOrderShipmentTables } from "../orders/orders.schema.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(...values: unknown[]) {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

export function verifySkydropxWebhook(authorization: string | undefined) {
  const expected = process.env.SKYDROPX_WEBHOOK_TOKEN?.trim();
  if (!expected) throw new ApiError(503, "SKYDROPX_WEBHOOK_TOKEN is not configured");
  const actual = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function mapStatus(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === "delivered") return "delivered";
  if (["last_mile", "delivery_attempt", "delivered_to_branch"].includes(normalized)) return "out_for_delivery";
  if (normalized === "picked_up") return "picked_up";
  if (["in_transit", "exception", "in_return", "retained"].includes(normalized)) return normalized;
  if (["created", "label_created"].includes(normalized)) return "label_created";
  if (["canceled", "cancelled", "destroyed"].includes(normalized)) return "canceled";
  return normalized || "label_created";
}

export async function handleSkydropxWebhook(payload: unknown) {
  await ensureOrderShipmentTables();
  const root = record(payload);
  const data = record(root.data);
  const attrs = record(data.attributes);
  const trackingNo = text(attrs.tracking_number, data.tracking_number);
  const status = text(attrs.returned_status, attrs.status, data.status);
  if (!trackingNo || !status) return { matched: false };

  const [rows] = await pool.query<(RowDataPacket & { os_id: number; or_id: number })[]>(
    `SELECT os_id, or_id
     FROM Order_shipments
     WHERE tracking_no = ?
     LIMIT 1`,
    [trackingNo]
  );
  const shipment = rows[0];
  if (!shipment) return { matched: false };

  const occurredAtRaw = text(attrs.occurred_at, attrs.updated_at, attrs.created_at, root.created_at);
  const occurredAt = occurredAtRaw && !Number.isNaN(new Date(occurredAtRaw).getTime())
    ? new Date(occurredAtRaw)
    : new Date();
  const internalStatus = mapStatus(status);
  const eventHash = crypto.createHash("sha256")
    .update([shipment.os_id, trackingNo, status, occurredAt.toISOString()].join("|"))
    .digest("hex");

  await pool.query(
    `INSERT INTO Order_shipment_events
      (os_id, or_id, tracking_code, courier_tracking_code, status, title, description, location, occurred_at, raw_json, event_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE raw_json = VALUES(raw_json), updated_at = CURRENT_TIMESTAMP`,
    [
      shipment.os_id,
      shipment.or_id,
      trackingNo,
      trackingNo,
      status,
      text(attrs.description, attrs.message) ?? status,
      text(attrs.description, attrs.message),
      text(attrs.location),
      occurredAt,
      JSON.stringify(payload),
      eventHash,
    ]
  );
  await pool.query(
    `UPDATE Order_shipments
     SET status = ?,
         tracking_url = COALESCE(?, tracking_url),
         label_url = COALESCE(?, label_url),
         updated_at = CURRENT_TIMESTAMP
     WHERE os_id = ?`,
    [internalStatus, text(attrs.tracking_url_provider), text(attrs.label_url), shipment.os_id]
  );
  await pool.query(
    `UPDATE Orders
     SET shipment_status = ?,
         tracking_url = COALESCE(?, tracking_url),
         label_url = COALESCE(?, label_url),
         update_at = CURRENT_TIMESTAMP
     WHERE or_id = ?`,
    [internalStatus, text(attrs.tracking_url_provider), text(attrs.label_url), shipment.or_id]
  );

  if (internalStatus === "delivered") {
    await pool.query(
      `UPDATE Orders o
       LEFT JOIN Status current_status ON current_status.s_id = o.s_id
       LEFT JOIN Status delivered_status ON delivered_status.s_code = 'DELIVERED'
       SET o.s_id = COALESCE(delivered_status.s_id, o.s_id), o.status = 'delivered', o.update_at = CURRENT_TIMESTAMP
       WHERE o.or_id = ?
         AND (current_status.s_code IS NULL OR current_status.s_code NOT IN
           ('CANCELLED', 'REFUNDED', 'RETURN_REQUESTED', 'RETURN_REQUESTED_COMPLETED', 'RECEIVED', 'AUTO_RECEIVED', 'REVIEWED'))`,
      [shipment.or_id]
    );
  }
  return { matched: true, or_id: shipment.or_id };
}

