import crypto from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import { getIO } from "../../socket/socket.js";
import {
    consumeReservationsForOrders,
    ensureInventoryReservationTable,
} from "../inventory/inventory-reservation.service.js";
import * as notificationService from "../notifications/notification.service.js";
import {
    BUYER_PAYABLE_STATUS_CODES,
    setOrdersStatus,
    type OrderStatusCode,
} from "../orders/order-status.service.js";
import type {
    MercadoPagoCheckoutInput,
    MercadoPagoPaymentResponse,
    MercadoPagoPaymentSearchResponse,
    MercadoPagoPreferenceResponse,
    MercadoPagoRefundResponse,
    PaymentResultDTO,
} from "./payment.type.js";

type PayableOrderRow = RowDataPacket & {
    or_id: number;
    order_no: string;
    u_id: number;
    st_id: number;
    status: string;
    status_code: string | null;
    grand_total: number;
    payment_expires_at: Date | string | null;
};

type PaymentOrderSocketRow = RowDataPacket & {
    or_id: number;
    order_no: string | null;
    u_id: number;
    st_id: number;
    grand_total: number | null;
    status_code?: string | null;
};

type UserContactRow = RowDataPacket & {
    u_email: string | null;
    u_username: string | null;
};

type PendingPaymentRow = RowDataPacket & {
    pay_id: number;
    payment_no: string;
    payment_ref: string | null;
    amount_total: number;
};

let mercadoPagoPaymentSchemaReady: Promise<void> | null = null;

// ฐานข้อมูลเดิมอาจกำหนด payment_method เป็น ENUM ของ Omise จึงเพิ่มค่าใหม่โดยยังเก็บค่าประวัติเดิมไว้
function ensureMercadoPagoPaymentSchema(): Promise<void> {
    mercadoPagoPaymentSchemaReady ??= pool.query<(RowDataPacket & { data_type: string; column_type: string })[]>(
        `SELECT DATA_TYPE AS data_type, COLUMN_TYPE AS column_type
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'Payments'
           AND COLUMN_NAME = 'payment_method'
         LIMIT 1`
    )
        .then(async ([columns]) => {
            const column = columns[0];
            if (!column || column.data_type.toLowerCase() !== "enum" || column.column_type.includes("'mercado_pago'")) return;

            await pool.query(
                "ALTER TABLE Payments MODIFY COLUMN payment_method ENUM('mercado_pago','card','promptpay','mobile_banking_kbank','mobile_banking_scb') NOT NULL"
            );
        })
        .then(() => undefined);

    return mercadoPagoPaymentSchemaReady;
}

export type PaymentOrderSummary = {
    or_id: number;
    order_no: string;
    grand_total: number;
};

function roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
}

function buildPaymentNo(): string {
    const now = new Date();
    const yyyymmdd =
        now.getFullYear().toString() +
        String(now.getMonth() + 1).padStart(2, "0") +
        String(now.getDate()).padStart(2, "0");
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-9);
    return `PAY${yyyymmdd}-${suffix}`;
}

function mercadoPagoAccessToken(): string {
    const token = process.env.MERCADO_PAGO_ACCESS_TOKEN?.trim();
    if (!token) throw new ApiError(503, "MERCADO_PAGO_ACCESS_TOKEN is not configured");
    return token;
}

function shopBaseUrl(): string {
    const value =
        process.env.ARCANA_SHOP_URL?.trim() ||
        process.env.SHOP_URL?.trim() ||
        process.env.FRONTEND_URL?.trim();
    if (!value) {
        throw new ApiError(503, "ARCANA_SHOP_URL, SHOP_URL, or FRONTEND_URL is required for Mercado Pago return URLs");
    }
    return value.replace(/\/$/, "");
}

function mercadoPagoReturnUrls() {
    const base = shopBaseUrl();
    return {
        success: process.env.MERCADO_PAGO_SUCCESS_URL?.trim() || `${base}/arcana/account/orders?payment=success`,
        pending: process.env.MERCADO_PAGO_PENDING_URL?.trim() || `${base}/arcana/account/orders?payment=pending`,
        failure: process.env.MERCADO_PAGO_FAILURE_URL?.trim() || `${base}/arcana/account/orders?payment=failure`,
    };
}

export async function mercadoPagoRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${mercadoPagoAccessToken()}`);
    headers.set("Content-Type", "application/json");

    const response = await fetch(`https://api.mercadopago.com${path}`, {
        ...init,
        headers,
    });
    const payload = await response.json().catch(() => ({})) as T & {
        message?: string;
        error?: string;
        cause?: unknown;
    };

    if (!response.ok) {
        throw new ApiError(
            response.status >= 500 ? 502 : 400,
            payload.message || payload.error || "No se pudo conectar con Mercado Pago",
            payload
        );
    }
    return payload;
}

async function getUserContact(conn: PoolConnection, uId: number): Promise<UserContactRow> {
    const [rows] = await conn.query<UserContactRow[]>(
        "SELECT u_email, u_username FROM Users WHERE u_id = ? LIMIT 1",
        [uId]
    );
    const user = rows[0];
    if (!user) throw new ApiError(404, "ไม่พบข้อมูลผู้ใช้");
    return user;
}

async function createMercadoPagoPreference(input: {
    paymentNo: string;
    uId: number;
    orders: PaymentOrderSummary[];
    payerEmail?: string | null;
}): Promise<MercadoPagoPreferenceResponse> {
    const backUrls = mercadoPagoReturnUrls();
    const notificationUrl = process.env.MERCADO_PAGO_WEBHOOK_URL?.trim();
    const payload = {
        items: input.orders.map((order) => ({
            id: String(order.or_id),
            title: `Pedido ${order.order_no}`,
            description: `Arcana Mexico - ${order.order_no}`,
            currency_id: "MXN",
            quantity: 1,
            unit_price: roundMoney(Number(order.grand_total)),
        })),
        external_reference: input.paymentNo,
        metadata: {
            payment_no: input.paymentNo,
            user_id: String(input.uId),
            order_ids: input.orders.map((order) => order.or_id).join(","),
        },
        ...(input.payerEmail ? { payer: { email: input.payerEmail } } : {}),
        back_urls: backUrls,
        auto_return: "approved",
        statement_descriptor: (process.env.MERCADO_PAGO_STATEMENT_DESCRIPTOR?.trim() || "ARCANA MEXICO").slice(0, 22),
        ...(notificationUrl ? { notification_url: notificationUrl } : {}),
    };

    const preference = await mercadoPagoRequest<MercadoPagoPreferenceResponse>("/checkout/preferences", {
        method: "POST",
        headers: { "X-Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(payload),
    });
    if (!preference.id) throw new ApiError(502, "Mercado Pago did not return a preference id", preference);
    return preference;
}

function preferenceCheckoutUrl(preference: MercadoPagoPreferenceResponse): string {
    const useSandbox = process.env.MERCADO_PAGO_USE_SANDBOX === "true";
    const url = useSandbox
        ? preference.sandbox_init_point || preference.init_point
        : preference.init_point;
    if (!url) throw new ApiError(502, "Mercado Pago did not return a checkout URL", preference);
    return url;
}

async function getPayableOrdersForUpdate(
    conn: PoolConnection,
    uId: number,
    orderIds: number[]
): Promise<PayableOrderRow[]> {
    const [rows] = await conn.query<PayableOrderRow[]>(
        `SELECT o.or_id, o.order_no, o.u_id, o.st_id, o.status, os.s_code AS status_code,
                o.grand_total, o.payment_expires_at
         FROM Orders o
         LEFT JOIN Status os ON os.s_id = o.s_id
         WHERE o.u_id = ? AND o.or_id IN (?)
         FOR UPDATE`,
        [uId, orderIds]
    );
    if (rows.length !== orderIds.length) {
        throw new ApiError(404, "พบคำสั่งซื้อบางรายการที่ไม่ใช่ของผู้ใช้ หรือไม่มีอยู่จริง");
    }
    const notPending = rows.find((order) => !BUYER_PAYABLE_STATUS_CODES.includes(order.status_code as OrderStatusCode));
    if (notPending) throw new ApiError(400, `คำสั่งซื้อ ${notPending.order_no} ไม่ได้อยู่ในสถานะรอชำระเงิน`);

    const now = Date.now();
    const expired = rows.find((order) => order.payment_expires_at && new Date(order.payment_expires_at).getTime() <= now);
    if (expired) throw new ApiError(400, `คำสั่งซื้อ ${expired.order_no} หมดเวลาชำระเงินแล้ว`);
    return rows;
}

function emitPaidOrderChanges(rows: PaymentOrderSocketRow[]) {
    if (!rows.length) return;
    try {
        const io = getIO();
        const orderIds = rows.map((row) => Number(row.or_id));
        for (const storeId of new Set(rows.map((row) => Number(row.st_id)).filter(Boolean))) {
            io.to(`STORE_${storeId}`).emit("order:changed", { event: "order:paid", order_ids: orderIds, status_code: "CONFIRMED" });
            io.to(`STORE_${storeId}`).emit("order:paid", { event: "order:paid", order_ids: orderIds, status_code: "CONFIRMED" });
        }
        for (const userId of new Set(rows.map((row) => Number(row.u_id)).filter(Boolean))) {
            io.to(`USER_${userId}`).emit("payment:confirmed", { order_ids: orderIds });
            io.to(`USER_${userId}`).emit("order:changed", { event: "order:paid", order_ids: orderIds, status_code: "CONFIRMED" });
        }
    } catch {
        // Socket อาจยังไม่ถูกเริ่มระหว่าง test
    }
}

export async function chargeAndRecordPayment(
    conn: PoolConnection,
    input: { u_id: number; payment_method: "mercado_pago"; orders: PaymentOrderSummary[] }
): Promise<PaymentResultDTO> {
    await ensureMercadoPagoPaymentSchema();
    if (!input.orders.length) throw new ApiError(400, "กรุณาระบุคำสั่งซื้อที่ต้องชำระเงิน");
    const amountTotal = roundMoney(input.orders.reduce((sum, order) => sum + Number(order.grand_total || 0), 0));
    if (amountTotal <= 0) throw new ApiError(400, "ยอดชำระเงินไม่ถูกต้อง");

    // ใช้ preference ที่ยัง pending เดิมเมื่อผู้ใช้กดจ่ายซ้ำ เพื่อป้องกันการสร้าง checkout หลายรายการให้ order ชุดเดียวกัน
    const orderIds = input.orders.map((order) => order.or_id);
    const [pendingRows] = await conn.query<PendingPaymentRow[]>(
        `SELECT p.pay_id, p.payment_no, p.payment_ref, p.amount_total
         FROM Payments p
         INNER JOIN Payment_orders po ON po.pay_id = p.pay_id
         WHERE p.u_id = ?
           AND p.payment_method = 'mercado_pago'
           AND p.payment_status = 'pending'
           AND po.or_id IN (?)
         GROUP BY p.pay_id, p.payment_no, p.payment_ref, p.amount_total
         HAVING COUNT(DISTINCT po.or_id) = ?
            AND (SELECT COUNT(*) FROM Payment_orders all_po WHERE all_po.pay_id = p.pay_id) = ?
         ORDER BY p.pay_id DESC
         LIMIT 1`,
        [input.u_id, orderIds, orderIds.length, orderIds.length]
    );
    const pending = pendingRows[0];
    if (pending?.payment_ref) {
        try {
            const preference = await mercadoPagoRequest<MercadoPagoPreferenceResponse>(
                `/checkout/preferences/${encodeURIComponent(pending.payment_ref)}`,
                { method: "GET" }
            );
            return {
                pay_id: Number(pending.pay_id),
                payment_no: pending.payment_no,
                payment_status: "pending",
                payment_ref: pending.payment_ref,
                amount_total: Number(pending.amount_total),
                checkout_url: preferenceCheckoutUrl(preference),
                order_ids: orderIds,
            };
        } catch (error) {
            // preference ที่ไม่มีแล้วสร้างใหม่ได้ แต่ถ้า Mercado Pago ล่มให้ส่ง error เดิมเพื่อป้องกันรายการซ้ำ
            if (!(error instanceof ApiError) || error.status >= 500) throw error;
        }
    }

    const paymentNo = buildPaymentNo();
    const user = await getUserContact(conn, input.u_id);
    const preference = await createMercadoPagoPreference({
        paymentNo,
        uId: input.u_id,
        orders: input.orders,
        payerEmail: user.u_email,
    });
    const checkoutUrl = preferenceCheckoutUrl(preference);

    const [result] = await conn.query<ResultSetHeader>(
        `INSERT INTO Payments
            (payment_no, amount_total, payment_method, payment_status, payment_ref, paid_at, created_at, u_id)
         VALUES (?, ?, 'mercado_pago', 'pending', ?, NULL, ?, ?)`,
        [paymentNo, amountTotal.toFixed(2), preference.id, new Date(), input.u_id]
    );
    const payId = result.insertId;
    await conn.query(
        "INSERT INTO Payment_orders (pay_id, or_id, created_at) VALUES ?",
        [input.orders.map((order) => [payId, order.or_id, new Date()])]
    );

    return {
        pay_id: payId,
        payment_no: paymentNo,
        payment_status: "pending",
        payment_ref: preference.id ?? null,
        amount_total: amountTotal,
        checkout_url: checkoutUrl,
        order_ids: input.orders.map((order) => order.or_id),
    };
}

function mapMercadoPagoStatus(status?: string): PaymentResultDTO["payment_status"] | null {
    if (status === "approved") return "paid";
    if (["rejected", "cancelled"].includes(status || "")) return "failed";
    if (["pending", "in_process", "authorized"].includes(status || "")) return "pending";
    return null;
}

export async function handleMercadoPagoPayment(paymentId: string): Promise<void> {
    const remote = await mercadoPagoRequest<MercadoPagoPaymentResponse>(`/v1/payments/${encodeURIComponent(paymentId)}`, { method: "GET" });
    const paymentStatus = mapMercadoPagoStatus(remote.status);
    const paymentNo = remote.external_reference?.trim();
    if (!paymentStatus || !paymentNo) return;

    await ensureInventoryReservationTable();
    const conn = await pool.getConnection();
    let confirmedOrders: PaymentOrderSocketRow[] = [];
    try {
        await conn.beginTransaction();
        const [payments] = await conn.query<(RowDataPacket & { pay_id: number; payment_status: string })[]>(
            "SELECT pay_id, payment_status FROM Payments WHERE payment_no = ? LIMIT 1 FOR UPDATE",
            [paymentNo]
        );
        const local = payments[0];
        if (!local) {
            await conn.rollback();
            return;
        }
        if (local.payment_status === "paid" || local.payment_status === "failed") {
            await conn.rollback();
            return;
        }

        await conn.query(
            "UPDATE Payments SET payment_status = ?, payment_ref = ?, paid_at = ? WHERE pay_id = ?",
            [paymentStatus, String(remote.id ?? paymentId), paymentStatus === "paid" ? new Date() : null, local.pay_id]
        );

        if (paymentStatus === "paid") {
            const [orders] = await conn.query<PaymentOrderSocketRow[]>(
                `SELECT o.or_id, o.order_no, o.u_id, o.st_id, o.grand_total, s.s_code AS status_code
                 FROM Payment_orders po
                 INNER JOIN Orders o ON o.or_id = po.or_id
                 LEFT JOIN Status s ON s.s_id = o.s_id
                 WHERE po.pay_id = ? FOR UPDATE`,
                [local.pay_id]
            );
            confirmedOrders = orders.filter((order) => order.status_code === "PENDING");
            const orderIds = confirmedOrders.map((order) => Number(order.or_id));
            if (orderIds.length) {
                await consumeReservationsForOrders(conn, orderIds);
                await setOrdersStatus(conn, orderIds, "CONFIRMED");
            }
        }
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }

    if (paymentStatus === "paid" && confirmedOrders.length) {
        emitPaidOrderChanges(confirmedOrders);
        for (const order of confirmedOrders) {
            try {
                await notificationService.CreateNotification({
                    target_type: "STORE",
                    target_id: Number(order.st_id),
                    type: "order:paid",
                    title: "Pago completado",
                    message: `El pedido ${order.order_no ?? order.or_id} ha sido pagado.`,
                    action_url: `/dashboard/orders?order_id=${order.or_id}`,
                    ref_type: "ORDER",
                    ref_id: Number(order.or_id),
                    priority: "HIGH",
                });
            } catch (error) {
                console.warn(`[payments] notification for order ${order.or_id} failed:`, error);
            }
        }
    }
}

async function findRemotePaymentByReference(paymentNo: string): Promise<MercadoPagoPaymentResponse | null> {
    const params = new URLSearchParams({ external_reference: paymentNo, sort: "date_created", criteria: "desc" });
    const result = await mercadoPagoRequest<MercadoPagoPaymentSearchResponse>(`/v1/payments/search?${params.toString()}`, { method: "GET" });
    return result.results?.[0] ?? null;
}

export async function syncMercadoPagoPayment(uId: number, orderIds: number[]): Promise<PaymentResultDTO> {
    const uniqueIds = [...new Set(orderIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!uniqueIds.length) throw new ApiError(400, "กรุณาระบุคำสั่งซื้อที่ต้องการตรวจสอบการชำระเงิน");

    const [rows] = await pool.query<(RowDataPacket & {
        pay_id: number;
        payment_no: string;
        payment_status: PaymentResultDTO["payment_status"];
        payment_ref: string | null;
        amount_total: number;
    })[]>(
        `SELECT DISTINCT p.pay_id, p.payment_no, p.payment_status, p.payment_ref, p.amount_total
         FROM Payments p
         INNER JOIN Payment_orders po ON po.pay_id = p.pay_id
         INNER JOIN Orders o ON o.or_id = po.or_id
         WHERE o.or_id IN (?) AND o.u_id = ? AND p.payment_method = 'mercado_pago'
         ORDER BY p.pay_id DESC LIMIT 1`,
        [uniqueIds, uId]
    );
    const payment = rows[0];
    if (!payment) throw new ApiError(404, "ไม่พบรายการชำระเงิน Mercado Pago ของคำสั่งซื้อนี้");

    if (payment.payment_status === "pending") {
        const remote = await findRemotePaymentByReference(payment.payment_no);
        if (remote?.id != null) await handleMercadoPagoPayment(String(remote.id));
    }

    const [updatedRows] = await pool.query<typeof rows>(
        "SELECT pay_id, payment_no, payment_status, payment_ref, amount_total FROM Payments WHERE pay_id = ? LIMIT 1",
        [payment.pay_id]
    );
    const updated = updatedRows[0] ?? payment;
    const [linkedOrders] = await pool.query<(RowDataPacket & { or_id: number })[]>(
        "SELECT or_id FROM Payment_orders WHERE pay_id = ?",
        [payment.pay_id]
    );
    return {
        pay_id: Number(updated.pay_id),
        payment_no: updated.payment_no,
        payment_status: updated.payment_status,
        payment_ref: updated.payment_ref,
        amount_total: Number(updated.amount_total),
        order_ids: linkedOrders.map((row) => Number(row.or_id)),
    };
}

export async function createMercadoPagoCheckout(input: MercadoPagoCheckoutInput): Promise<PaymentResultDTO> {
    await ensureInventoryReservationTable();
    const orderIds = [...new Set(input.order_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!orderIds.length) throw new ApiError(400, "กรุณาระบุคำสั่งซื้อที่ต้องชำระเงิน");

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const orders = await getPayableOrdersForUpdate(conn, input.u_id, orderIds);
        const payment = await chargeAndRecordPayment(conn, {
            u_id: input.u_id,
            payment_method: "mercado_pago",
            orders,
        });
        await conn.commit();
        return payment;
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

export async function createMercadoPagoRefund(input: {
    paymentId: string;
    amount?: number;
    metadata?: Record<string, string>;
}): Promise<MercadoPagoRefundResponse> {
    if (!input.paymentId.trim()) throw new ApiError(400, "ไม่พบ Mercado Pago payment id สำหรับคืนเงิน");
    const body = input.amount != null ? JSON.stringify({ amount: roundMoney(input.amount) }) : undefined;
    return mercadoPagoRequest<MercadoPagoRefundResponse>(
        `/v1/payments/${encodeURIComponent(input.paymentId.trim())}/refunds`,
        {
            method: "POST",
            headers: { "X-Idempotency-Key": crypto.randomUUID() },
            ...(body ? { body } : {}),
        }
    );
}

export function verifyMercadoPagoWebhookSignature(input: {
    xSignature?: string | undefined;
    xRequestId?: string | undefined;
    dataId?: string | undefined;
}): boolean {
    const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET?.trim();
    if (!secret || !input.xSignature || !input.xRequestId || !input.dataId) return false;
    const parts = Object.fromEntries(
        input.xSignature.split(",").map((part) => {
            const [key, ...rest] = part.trim().split("=");
            return [key, rest.join("=")];
        })
    );
    if (!parts.ts || !parts.v1) return false;
    const manifest = `id:${input.dataId};request-id:${input.xRequestId};ts:${parts.ts};`;
    const expected = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
    const actualBuffer = Buffer.from(parts.v1, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
