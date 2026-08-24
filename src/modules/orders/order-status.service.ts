import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { ApiError } from "../../shared/errors/ApiError.js";

export type OrderStatusCode =
    | "PENDING"
    | "CONFIRMED"
    | "PROCESSING"
    | "PACKED"
    | "READY_TO_SHIP"
    | "DELIVERED"
    | "RECEIVED"
    | "AUTO_RECEIVED"
    | "REVIEWED"
    | "CANCELLED"
    | "REFUNDED"
    | "RETURN_REQUESTED"
    | "RETURN_REQUESTED_COMPLETED";

const LEGACY_STATUS_BY_CODE: Record<OrderStatusCode, string> = {
    PENDING: "pending",
    CONFIRMED: "paid",
    PROCESSING: "packing",
    PACKED: "packing",
    READY_TO_SHIP: "shipped",
    DELIVERED: "delivered",
    RECEIVED: "completed",
    AUTO_RECEIVED: "completed",
    REVIEWED: "reviewed",
    CANCELLED: "cancelled",
    REFUNDED: "refunded",
    RETURN_REQUESTED: "refunded",
    RETURN_REQUESTED_COMPLETED: "refunded",
};

export const BUYER_PAYABLE_STATUS_CODES: OrderStatusCode[] = ["PENDING"];
export const BUYER_CANCELLABLE_STATUS_CODES: OrderStatusCode[] = ["PENDING"];

export function toLegacyOrderStatus(statusCode: OrderStatusCode): string {
    return LEGACY_STATUS_BY_CODE[statusCode];
}

export async function getOrderStatusId(
    conn: PoolConnection,
    statusCode: OrderStatusCode
): Promise<number> {
    const [rows] = await conn.query<(RowDataPacket & { s_id: number })[]>(
        "SELECT s_id FROM Status WHERE s_code = ? LIMIT 1",
        [statusCode]
    );
    const status = rows[0];
    if (!status) throw new ApiError(500, `ไม่พบสถานะคำสั่งซื้อ ${statusCode}`);
    return Number(status.s_id);
}

export async function setOrdersStatus(
    conn: PoolConnection,
    orderIds: number[],
    statusCode: OrderStatusCode,
    options: { remark?: string; whereUserId?: number } = {}
): Promise<void> {
    if (orderIds.length === 0) return;

    const statusId = await getOrderStatusId(conn, statusCode);
    const legacyStatus = toLegacyOrderStatus(statusCode);
    const fields = [
        "s_id = ?",
        "status = ?",
        "update_at = ?",
    ];
    const values: unknown[] = [statusId, legacyStatus, new Date()];

    if (options.remark !== undefined) {
        fields.push("remark = ?");
        values.push(options.remark);
    }

    const userClause = options.whereUserId ? " AND u_id = ?" : "";
    values.push(orderIds);
    if (options.whereUserId) values.push(options.whereUserId);

    // ระหว่าง migration เรายัง sync Orders.status เดิมไว้ด้วย
    // แต่ logic ใหม่ควรอ่านจาก Status.s_code ผ่าน Orders.s_id เป็นหลัก
    const [result] = await conn.query<ResultSetHeader>(
        `UPDATE Orders SET ${fields.join(", ")} WHERE or_id IN (?)${userClause}`,
        values
    );

    if (result.affectedRows === 0) {
        throw new ApiError(404, "ไม่พบคำสั่งซื้อที่ต้องอัปเดตสถานะ");
    }
}
