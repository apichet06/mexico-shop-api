import crypto from "crypto";
import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import { getIO } from "../../socket/socket.js";
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

function mapStatus(status: string, description = "") {
  const normalized = status.toLowerCase();
  const detail = `${normalized} ${description.toLowerCase()}`;
  if (
    ["recipient_refused", "refused", "refused_by_recipient", "rejected_by_recipient"].includes(normalized)
    || /recipient\s+(refused|rejected)|refused\s+by\s+(the\s+)?recipient|destinatario\s+(rechaz[oó]|rehus[oó])|rechazo\s+del\s+destinatario/.test(detail)
  ) return "recipient_refused";
  if (
    ["return_to_sender", "returning_to_sender", "in_return"].includes(normalized)
    || /return(ing)?\s+to\s+sender|devoluci[oó]n\s+al\s+remitente|retorno\s+a(l\s+)?origen/.test(detail)
  ) return "return_to_sender";
  if (["returned_to_sender", "return_delivered"].includes(normalized)) return "returned_to_sender";
  if (normalized === "delivered") return "delivered";
  if (["last_mile", "delivery_attempt", "delivered_to_branch"].includes(normalized)) return "out_for_delivery";
  if (normalized === "picked_up") return "picked_up";
  if (["in_transit", "exception", "retained"].includes(normalized)) return normalized;
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
  const providerShipmentId = text(attrs.shipment_id, data.id, root.shipment_id);
  const status = text(attrs.returned_status, attrs.status, data.status);
  if ((!trackingNo && !providerShipmentId) || !status) return { matched: false };

  const [rows] = await pool.query<(RowDataPacket & {
    os_id: number;
    or_id: number;
    st_id: number;
    u_id: number | null;
    order_no: string;
    is_active: number;
  })[]>(
    `SELECT osh.os_id, osh.or_id, osh.is_active, o.st_id, o.u_id, o.order_no
     FROM Order_shipments osh
     INNER JOIN Orders o ON o.or_id = osh.or_id
     WHERE (? IS NOT NULL AND osh.tracking_no = ?)
        OR (? IS NOT NULL AND osh.provider_shipment_id = ?)
     LIMIT 1`,
    [trackingNo, trackingNo, providerShipmentId, providerShipmentId]
  );
  const shipment = rows[0];
  if (!shipment) return { matched: false };

  const occurredAtRaw = text(attrs.occurred_at, attrs.updated_at, attrs.created_at, root.created_at);
  const occurredAt = occurredAtRaw && !Number.isNaN(new Date(occurredAtRaw).getTime())
    ? new Date(occurredAtRaw)
    : new Date();
  const providerDescription = text(attrs.description, attrs.message) ?? status;
  const internalStatus = mapStatus(status, providerDescription);
  const eventHash = crypto.createHash("sha256")
    .update([shipment.os_id, trackingNo ?? providerShipmentId, status, occurredAt.toISOString()].join("|"))
    .digest("hex");

  await pool.query(
    `INSERT INTO Order_shipment_events
      (os_id, or_id, tracking_code, courier_tracking_code, status, title, description, location, occurred_at, raw_json, event_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE raw_json = VALUES(raw_json), updated_at = CURRENT_TIMESTAMP`,
    [
      shipment.os_id,
      shipment.or_id,
      trackingNo ?? providerShipmentId,
      trackingNo,
      status,
      providerDescription,
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
         tracking_no = COALESCE(?, tracking_no),
         tracking_url = COALESCE(?, tracking_url),
         label_url = COALESCE(?, label_url),
         canceled_at = CASE WHEN ? = 'canceled' THEN ? ELSE canceled_at END,
         failure_reason = CASE WHEN ? IN ('canceled', 'recipient_refused', 'return_to_sender', 'returned_to_sender') THEN ? ELSE failure_reason END,
         updated_at = CURRENT_TIMESTAMP
     WHERE os_id = ?`,
    [
      internalStatus,
      trackingNo,
      text(attrs.tracking_url_provider),
      text(attrs.label_url),
      internalStatus,
      occurredAt,
      internalStatus,
      providerDescription,
      shipment.os_id,
    ]
  );
  if (Number(shipment.is_active) === 1) {
    await pool.query(
      `UPDATE Orders
       SET shipment_status = ?,
           tracking_no = COALESCE(?, tracking_no),
           tracking_url = COALESCE(?, tracking_url),
           label_url = COALESCE(?, label_url),
           update_at = CURRENT_TIMESTAMP
       WHERE or_id = ?`,
      [internalStatus, trackingNo, text(attrs.tracking_url_provider), text(attrs.label_url), shipment.or_id]
    );
  }

  if (internalStatus === "delivered" && Number(shipment.is_active) === 1) {
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

  // Keep late events from an old attempt as history, but do not push them as
  // the current order state after a replacement shipment is active.
  if (Number(shipment.is_active) !== 1) {
    return { matched: true, or_id: shipment.or_id };
  }

  try {
    const payload = {
      event: "order:shipment_updated",
      actor: "skydropx",
      created_at: new Date(),
      order: {
        or_id: shipment.or_id,
        order_no: shipment.order_no,
        st_id: shipment.st_id,
        u_id: shipment.u_id,
        tracking_no: trackingNo,
        shipment_status: internalStatus,
      },
    };
    const io = getIO();
    io.to(`STORE_${shipment.st_id}`).emit("order:shipment_updated", payload);
    io.to(`STORE_${shipment.st_id}`).emit("order:changed", payload);
    if (shipment.u_id) {
      io.to(`USER_${shipment.u_id}`).emit("order:shipment_updated", payload);
      io.to(`USER_${shipment.u_id}`).emit("order:changed", payload);
    }
  } catch (error) {
    // Database updates must still succeed if Socket.IO is temporarily unavailable.
    console.warn("[shipping] emit Skydropx shipment update failed:", {
      or_id: shipment.or_id,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return { matched: true, or_id: shipment.or_id };
}
