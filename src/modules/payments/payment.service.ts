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
    ConektaCheckoutInput,
    ConektaOrderResponse,
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
    shipping_name: string | null;
    shipping_phone: string | null;
};

type PendingPaymentRow = RowDataPacket & {
    pay_id: number;
    payment_no: string;
    payment_ref: string | null;
    amount_total: number;
};

let conektaPaymentSchemaReady: Promise<void> | null = null;

function ensureConektaPaymentSchema(): Promise<void> {
    conektaPaymentSchemaReady ??= pool.query<(RowDataPacket & { data_type: string; column_type: string })[]>(
        `SELECT DATA_TYPE AS data_type, COLUMN_TYPE AS column_type
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'Payments'
           AND COLUMN_NAME = 'payment_method'
         LIMIT 1`
    )
        .then(async ([columns]) => {
            const column = columns[0];
            if (!column || column.data_type.toLowerCase() !== "enum" || column.column_type.includes("'conekta'")) return;

            await pool.query(
                `ALTER TABLE Payments MODIFY COLUMN payment_method ${column.column_type.slice(0, -1)},'conekta') NOT NULL`
            );
        })
        .then(() => undefined);

    return conektaPaymentSchemaReady;
}

export type PaymentOrderSummary = {
    or_id: number;
    order_no: string;
    grand_total: number;
    payment_expires_at?: Date | string | null | undefined;
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

function conektaPrivateKey(): string {
    const key = process.env.CONEKTA_PRIVATE_KEY?.trim();
    if (!key) throw new ApiError(503, "CONEKTA_PRIVATE_KEY is not configured");
    return key;
}

function shopBaseUrl(): string {
    const value =
        process.env.ARCANA_SHOP_URL?.trim() ||
        process.env.SHOP_URL?.trim() ||
        process.env.FRONTEND_URL?.trim();
    if (!value) {
        throw new ApiError(503, "ARCANA_SHOP_URL, SHOP_URL, or FRONTEND_URL is required for Conekta return URLs");
    }
    return value.replace(/\/$/, "");
}

function conektaReturnUrls() {
    const base = shopBaseUrl();
    return {
        success: `${base}/arcana/account/orders?payment=success`,
        failure: `${base}/arcana/account/orders?payment=failure`,
    };
}

export async function conektaRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${conektaPrivateKey()}`);
    headers.set("Accept", "application/vnd.conekta-v2.3.0+json");
    headers.set("Accept-Language", "es");
    headers.set("Content-Type", "application/json");

    const response = await fetch(`https://api.conekta.io${path}`, {
        ...init,
        headers,
    });
    const payload = await response.json().catch(() => ({})) as T & {
        message?: string;
        error?: string;
        details?: { message?: string }[];
    };

    if (!response.ok) {
        throw new ApiError(
            response.status >= 500 ? 502 : response.status === 401 || response.status === 403 ? 503 : response.status,
            payload.details?.[0]?.message || payload.message || payload.error || "No se pudo conectar con Conekta",
            payload
        );
    }
    return payload;
}

async function getUserContact(conn: PoolConnection, uId: number): Promise<UserContactRow> {
    const [rows] = await conn.query<UserContactRow[]>(
        `SELECT u.u_email, u.u_username, o.shipping_name, o.shipping_phone
         FROM Users u
         LEFT JOIN Orders o ON o.u_id = u.u_id
         WHERE u.u_id = ? ORDER BY o.or_id DESC LIMIT 1`, [uId]);
    const user = rows[0];
    if (!user) throw new ApiError(404, "ไม่พบข้อมูลผู้ใช้");
    return user;
}

async function createConektaOrder(input: {
    paymentNo: string;
    uId: number;
    orders: PaymentOrderSummary[];
    payer: UserContactRow;
    expiresAt: Date;
}): Promise<ConektaOrderResponse> {
    const backUrls = conektaReturnUrls();
    const phone = input.payer.shipping_phone?.replace(/\D/g, "").slice(-10);
    if (!input.payer.u_email || !phone || phone.length !== 10) {
        throw new ApiError(400, "กรุณาระบุอีเมลและหมายเลขโทรศัพท์สำหรับการชำระเงิน");
    }
    const payload = {
        line_items: input.orders.map((order) => ({
            name: `Pedido ${order.order_no}`,
            quantity: 1,
            unit_price: Math.round(Number(order.grand_total) * 100),
        })),
        metadata: {
            payment_no: input.paymentNo,
            user_id: String(input.uId),
            order_ids: input.orders.map((order) => order.or_id).join(","),
        },
        customer_info: {
            name: input.payer.shipping_name || input.payer.u_username || "Cliente",
            email: input.payer.u_email,
            phone,
        },
        currency: "MXN",
        checkout: {
            type: "HostedPayment",
            name: `Arcana Mexico ${input.paymentNo}`,
            expires_at: Math.floor(input.expiresAt.getTime() / 1000),
            success_url: `${backUrls.success}&order_ids=${input.orders.map((order) => order.or_id).join(",")}`,
            failure_url: `${backUrls.failure}&order_ids=${input.orders.map((order) => order.or_id).join(",")}`,
            excluded_payment_methods: ["bnpl", "pay_by_bank"],
        },
    };

    const order = await conektaRequest<ConektaOrderResponse>("/orders", {
        method: "POST",
        body: JSON.stringify(payload),
    });
    if (order.livemode) throw new ApiError(503, "Conekta live payments are disabled during sandbox integration");
    if (!order.id || !order.checkout?.url) throw new ApiError(502, "Conekta did not return a checkout URL", order);
    return order;
}

function conektaCheckoutUrl(order: ConektaOrderResponse): string {
    const url = order.checkout?.url;
    if (!url) throw new ApiError(502, "Conekta did not return a checkout URL", order);
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
    input: { u_id: number; payment_method: "conekta"; orders: PaymentOrderSummary[] }
): Promise<PaymentResultDTO> {
    await ensureConektaPaymentSchema();
    if (!input.orders.length) throw new ApiError(400, "กรุณาระบุคำสั่งซื้อที่ต้องชำระเงิน");
    const amountTotal = roundMoney(input.orders.reduce((sum, order) => sum + Number(order.grand_total || 0), 0));
    if (amountTotal <= 0) throw new ApiError(400, "ยอดชำระเงินไม่ถูกต้อง");

    // Reuse a pending checkout for the same group of orders.
    const orderIds = input.orders.map((order) => order.or_id);
    const [pendingRows] = await conn.query<PendingPaymentRow[]>(
        `SELECT p.pay_id, p.payment_no, p.payment_ref, p.amount_total
         FROM Payments p
         INNER JOIN Payment_orders po ON po.pay_id = p.pay_id
         WHERE p.u_id = ?
           AND p.payment_method = 'conekta'
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
            const remote = await conektaRequest<ConektaOrderResponse>(
                `/orders/${encodeURIComponent(pending.payment_ref)}`,
                { method: "GET" }
            );
            if (remote.payment_status === "paid") {
                throw new ApiError(409, "Payment already completed; refresh the order status");
            }
            if ((remote.payment_status === "pending_payment" || remote.payment_status == null) && !remote.checkout?.url) {
                throw new ApiError(409, "Conekta checkout URL is unavailable");
            }
            if (remote.payment_status !== "pending_payment" && remote.payment_status != null) throw new ApiError(410, "Checkout expired");
            return {
                pay_id: Number(pending.pay_id),
                payment_no: pending.payment_no,
                payment_status: "pending",
                payment_ref: pending.payment_ref,
                amount_total: Number(pending.amount_total),
                checkout_url: conektaCheckoutUrl(remote),
                order_ids: orderIds,
            };
        } catch (error) {
            // Only a missing or expired remote order can be replaced.
            if (!(error instanceof ApiError) || ![404, 410].includes(error.status)) throw error;
        }
    }

    const paymentNo = buildPaymentNo();
    const user = await getUserContact(conn, input.u_id);
    const minimumExpiry = Date.now() + (2 * 24 * 60 + 5) * 60_000;
    const requestedExpiry = Math.min(...input.orders.map((order) =>
        order.payment_expires_at ? new Date(order.payment_expires_at).getTime() : minimumExpiry
    ));
    const expiresAt = new Date(Math.max(Number.isFinite(requestedExpiry) ? requestedExpiry : minimumExpiry, minimumExpiry));
    await conn.query(
        "UPDATE Orders SET payment_expires_at = ? WHERE or_id IN (?)",
        [expiresAt, orderIds]
    );
    const remote = await createConektaOrder({
        paymentNo,
        uId: input.u_id,
        orders: input.orders,
        payer: user,
        expiresAt,
    });
    const checkoutUrl = conektaCheckoutUrl(remote);

    const [result] = await conn.query<ResultSetHeader>(
        `INSERT INTO Payments
            (payment_no, amount_total, payment_method, payment_status, payment_ref, paid_at, created_at, u_id)
         VALUES (?, ?, 'conekta', 'pending', ?, NULL, ?, ?)`,
        [paymentNo, amountTotal.toFixed(2), remote.id, new Date(), input.u_id]
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
        payment_ref: remote.id,
        amount_total: amountTotal,
        checkout_url: checkoutUrl,
        order_ids: input.orders.map((order) => order.or_id),
    };
}

function mapConektaStatus(status?: string | null): PaymentResultDTO["payment_status"] | null {
    if (status === "paid") return "paid";
    if (["declined", "canceled", "expired", "voided"].includes(status || "")) return "failed";
    if (status == null || ["pending_payment", "pre_authorized"].includes(status)) return "pending";
    return null;
}

export async function handleConektaOrder(orderId: string): Promise<void> {
    const remote = await conektaRequest<ConektaOrderResponse>(`/orders/${encodeURIComponent(orderId)}`, { method: "GET" });
    const paymentStatus = mapConektaStatus(remote.payment_status);
    if (!paymentStatus || remote.currency !== "MXN" || remote.livemode) return;

    await ensureInventoryReservationTable();
    const conn = await pool.getConnection();
    let confirmedOrders: PaymentOrderSocketRow[] = [];
    try {
        await conn.beginTransaction();
        const [payments] = await conn.query<(RowDataPacket & { pay_id: number; payment_status: string; amount_total: number })[]>(
            "SELECT pay_id, payment_status, amount_total FROM Payments WHERE payment_ref = ? AND payment_method = 'conekta' LIMIT 1 FOR UPDATE",
            [remote.id]
        );
        const local = payments[0];
        if (!local) {
            await conn.rollback();
            return;
        }
        if (local.payment_status === "paid" || (local.payment_status === "failed" && paymentStatus !== "paid")) {
            await conn.rollback();
            return;
        }
        if (Math.round(Number(local.amount_total) * 100) !== remote.amount) {
            throw new ApiError(409, "Conekta order amount differs from local payment");
        }

        if (paymentStatus === "pending") {
            const referenceExpiry = Math.max(0, ...(remote.charges?.data ?? []).map((charge) =>
                Number(charge.payment_method?.expires_at ?? 0)
            ));
            if (Number.isFinite(referenceExpiry) && referenceExpiry * 1000 > Date.now()) {
                await conn.query(
                    `UPDATE Orders o
                     INNER JOIN Payment_orders po ON po.or_id = o.or_id
                     SET o.payment_expires_at = GREATEST(o.payment_expires_at, FROM_UNIXTIME(?))
                     WHERE po.pay_id = ?`,
                    [referenceExpiry, local.pay_id]
                );
            }
        }

        await conn.query(
            "UPDATE Payments SET payment_status = ?, payment_ref = ?, paid_at = ? WHERE pay_id = ?",
            [paymentStatus, remote.id, paymentStatus === "paid" ? new Date() : null, local.pay_id]
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

export async function syncConektaPayment(uId: number, orderIds: number[]): Promise<PaymentResultDTO> {
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
         WHERE o.or_id IN (?) AND o.u_id = ? AND p.payment_method = 'conekta'
         ORDER BY p.pay_id DESC LIMIT 1`,
        [uniqueIds, uId]
    );
    const payment = rows[0];
    if (!payment) throw new ApiError(404, "ไม่พบรายการชำระเงิน Conekta ของคำสั่งซื้อนี้");

    if (payment.payment_status === "pending" && payment.payment_ref) {
        await handleConektaOrder(payment.payment_ref);
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

// Reconcile asynchronous cash/SPEI payments even when a webhook was delayed or missed.
let lastReconciledPayId = 0;
export async function reconcilePendingConektaPayments(limit = 50): Promise<number> {
    const [rows] = await pool.query<(RowDataPacket & { pay_id: number; payment_ref: string })[]>(
        `SELECT p.pay_id, p.payment_ref
         FROM Payments p
         WHERE p.payment_method = 'conekta'
           AND p.payment_status = 'pending'
           AND p.payment_ref IS NOT NULL
           AND p.pay_id > ?
           AND EXISTS (
               SELECT 1 FROM Payment_orders po
               INNER JOIN Orders o ON o.or_id = po.or_id
               INNER JOIN Status s ON s.s_id = o.s_id
               WHERE po.pay_id = p.pay_id AND s.s_code = 'PENDING'
           )
         ORDER BY p.pay_id ASC
         LIMIT ?`,
        [lastReconciledPayId, limit]
    );

    if (!rows.length && lastReconciledPayId !== 0) {
        lastReconciledPayId = 0;
        return reconcilePendingConektaPayments(limit);
    }

    let reconciled = 0;
    for (const row of rows) {
        lastReconciledPayId = Number(row.pay_id);
        try {
            await handleConektaOrder(row.payment_ref);
            reconciled++;
        } catch (error) {
            console.error(`[payments] Conekta reconciliation failed for ${row.payment_ref}:`, error);
        }
    }
    return reconciled;
}

let conektaReconciliationJobStarted = false;
export function startConektaReconciliationJob(intervalMs = 60_000): void {
    if (conektaReconciliationJobStarted) return;
    conektaReconciliationJobStarted = true;
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            await reconcilePendingConektaPayments();
        } catch (error) {
            console.error("[payments] Conekta reconciliation job failed:", error);
        } finally {
            running = false;
        }
    };
    void run();
    setInterval(() => { void run(); }, intervalMs);
}

export async function createConektaCheckout(input: ConektaCheckoutInput): Promise<PaymentResultDTO> {
    await ensureInventoryReservationTable();
    const orderIds = [...new Set(input.order_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!orderIds.length) throw new ApiError(400, "กรุณาระบุคำสั่งซื้อที่ต้องชำระเงิน");

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const orders = await getPayableOrdersForUpdate(conn, input.u_id, orderIds);
        const payment = await chargeAndRecordPayment(conn, {
            u_id: input.u_id,
            payment_method: "conekta",
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

export async function createConektaRefund(input: {
    orderId: string;
    amount?: number;
}): Promise<ConektaOrderResponse> {
    if (!input.orderId.trim()) throw new ApiError(400, "ไม่พบ Conekta order id สำหรับคืนเงิน");
    const body = JSON.stringify({
        reason: "requested_by_client",
        ...(input.amount != null ? { amount: Math.round(input.amount * 100) } : {}),
    });
    return conektaRequest<ConektaOrderResponse>(
        `/orders/${encodeURIComponent(input.orderId.trim())}/refunds`,
        {
            method: "POST",
            body,
        }
    );
}

export function verifyConektaWebhookSignature(rawBody: Buffer | undefined, digest: string | undefined): boolean {
    const publicKey = process.env.CONEKTA_WEBHOOK_PUBLIC_KEY?.replace(/\\n/g, "\n").trim();
    if (!publicKey || !rawBody || !digest) return false;
    try {
        return crypto.verify("RSA-SHA256", rawBody, publicKey, Buffer.from(digest, "base64"));
    } catch {
        return false;
    }
}
