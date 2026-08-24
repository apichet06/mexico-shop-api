import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import { env } from "../../config/env.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import {
    consumeReservationsForOrders,
    ensureInventoryReservationTable,
} from "../inventory/inventory-reservation.service.js";
import {
    BUYER_PAYABLE_STATUS_CODES,
    setOrdersStatus,
    type OrderStatusCode,
} from "../orders/order-status.service.js";
import { getIO } from "../../socket/socket.js";
import * as notificationService from "../notifications/notification.service.js";
import type {
    OmiseCardDTO,
    OmiseChargeInput,
    OmiseChargeResponse,
    OmiseCustomerDTO,
    OmiseRefundResponse,
    OmiseTokenDTO,
    PaymentResultDTO,
    SavedPaymentMethodDTO,
} from "./payment.type.js";

const OMISE_MOBILE_BANKING_SOURCE_BY_METHOD = {
    mobile_banking_kbank: "mobile_banking_kbank",
    mobile_banking_scb: "mobile_banking_scb",
} as const;

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
};

type SavedPaymentMethodRow = RowDataPacket & {
    upm_id: number;
    u_id: number;
    provider: "omise";
    provider_customer_id: string;
    provider_card_id: string;
    card_fingerprint: string | null;
    card_brand: string | null;
    card_last4: string;
    card_name: string | null;
    expiration_month: number | null;
    expiration_year: number | null;
    is_default: number;
    is_active: number;
    created_at: Date | string;
    updated_at: Date | string;
};

type UserContactRow = RowDataPacket & {
    u_email: string | null;
    u_username: string | null;
};

let paymentMethodTableReady: Promise<void> | null = null;

function roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
}

function toSatang(amount: number): number {
    return Math.round(roundMoney(amount) * 100);
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

export type PaymentOrderSummary = {
    or_id: number;
    order_no: string;
    grand_total: number;
};

function omiseAuthHeader(): string {
    if (!env.OMISE_SECRET_KEY) {
        throw new ApiError(500, "ยังไม่ได้ตั้งค่า OMISE_SECRET_KEY ที่ API server");
    }
    // Omise ใช้ HTTP Basic Auth โดยใส่ secret key เป็น username และ password ว่าง
    return `Basic ${Buffer.from(`${env.OMISE_SECRET_KEY}:`).toString("base64")}`;
}

function omisePublicAuthHeader(): string {
    if (!env.OMISE_PUBLIC_KEY) {
        throw new ApiError(500, "ยังไม่ได้ตั้งค่า OMISE_PUBLIC_KEY ที่ API server");
    }
    return `Basic ${Buffer.from(`${env.OMISE_PUBLIC_KEY}:`).toString("base64")}`;
}

export async function omiseRequest<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetch(`https://api.omise.co${path}`, {
        ...init,
        headers: {
            Authorization: omiseAuthHeader(),
            "Content-Type": "application/x-www-form-urlencoded",
            ...(init.headers ?? {}),
        },
    });

    const text = await res.text();
    const payload = (text ? JSON.parse(text) : {}) as T & { message?: string };
    if (!res.ok) {
        throw new ApiError(400, payload.message || "เชื่อมต่อ Omise ไม่สำเร็จ", payload);
    }

    return payload;
}

async function omiseVaultRequest<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetch(`https://vault.omise.co${path}`, {
        ...init,
        headers: {
            Authorization: omisePublicAuthHeader(),
            "Content-Type": "application/x-www-form-urlencoded",
            ...(init.headers ?? {}),
        },
    });

    const text = await res.text();
    const payload = (text ? JSON.parse(text) : {}) as T & { message?: string };
    if (!res.ok) {
        throw new ApiError(400, payload.message || "อ่าน token จาก Omise ไม่สำเร็จ", payload);
    }

    return payload;
}

async function createOmiseSource(type: string, amountSatang: number, label: string): Promise<string> {
    const body = new URLSearchParams();
    body.set("type", type);
    body.set("amount", String(amountSatang));
    body.set("currency", "thb");

    const source = await omiseRequest<{ id?: string }>("/sources", {
        method: "POST",
        body,
    });

    if (!source.id) {
        throw new ApiError(400, `ไม่สามารถสร้าง ${label} source ได้`);
    }
    return source.id;
}

async function createOmisePromptPaySource(amountSatang: number): Promise<string> {
    return createOmiseSource("promptpay", amountSatang, "PromptPay");
}

async function createOmiseMobileBankingSource(
    paymentMethod: keyof typeof OMISE_MOBILE_BANKING_SOURCE_BY_METHOD,
    amountSatang: number
): Promise<string> {
    return createOmiseSource(
        OMISE_MOBILE_BANKING_SOURCE_BY_METHOD[paymentMethod],
        amountSatang,
        "Mobile Banking"
    );
}

function toPaymentRecordMethod(paymentMethod: OmiseChargeInput["payment_method"]): string {
    if (paymentMethod === "card") return "omise_card";
    if (paymentMethod === "promptpay") return "omise_promptpay";
    return `omise_${paymentMethod}`;
}

function buildOmiseFailureMessage(charge: OmiseChargeResponse, fallback: string): string {
    return charge.failure_message || charge.failure_code || fallback;
}

async function ensurePaymentMethodTable(): Promise<void> {
    paymentMethodTableReady ??= pool.query(`
        CREATE TABLE IF NOT EXISTS User_payment_methods (
            upm_id INT NOT NULL AUTO_INCREMENT,
            u_id INT NOT NULL,
            provider VARCHAR(32) NOT NULL DEFAULT 'omise',
            provider_customer_id VARCHAR(80) NOT NULL,
            provider_card_id VARCHAR(80) NOT NULL,
            card_fingerprint VARCHAR(128) NULL,
            card_brand VARCHAR(40) NULL,
            card_last4 VARCHAR(8) NOT NULL,
            card_name VARCHAR(160) NULL,
            expiration_month TINYINT NULL,
            expiration_year SMALLINT NULL,
            is_default TINYINT(1) NOT NULL DEFAULT 0,
            is_active TINYINT(1) NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            deleted_at DATETIME NULL,
            PRIMARY KEY (upm_id),
            UNIQUE KEY uq_user_payment_provider_card (provider, provider_card_id),
            KEY idx_user_payment_methods_user (u_id, is_active, is_default)
        )
    `)
        .then(async () => {
            const [columns] = await pool.query<(RowDataPacket & { column_name: string })[]>(
                `SELECT COLUMN_NAME AS column_name
                 FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'User_payment_methods'
                   AND COLUMN_NAME = 'card_fingerprint'`
            );
            if (columns.length === 0) {
                await pool.query("ALTER TABLE User_payment_methods ADD COLUMN card_fingerprint VARCHAR(128) NULL AFTER provider_card_id");
            }
        })
        .then(() => undefined);

    return paymentMethodTableReady;
}

function toPaymentMethodDTO(row: SavedPaymentMethodRow): SavedPaymentMethodDTO {
    return {
        upm_id: Number(row.upm_id),
        provider: row.provider,
        provider_customer_id: row.provider_customer_id,
        provider_card_id: row.provider_card_id,
        card_brand: row.card_brand,
        card_last4: row.card_last4,
        card_name: row.card_name,
        expiration_month: row.expiration_month === null ? null : Number(row.expiration_month),
        expiration_year: row.expiration_year === null ? null : Number(row.expiration_year),
        is_default: Number(row.is_default) === 1,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
    };
}

function pickCardFromCustomer(customer: OmiseCustomerDTO): OmiseCardDTO {
    const cards = customer.cards?.data ?? [];
    const card = cards.find((item) => item.id === customer.default_card) ?? cards[cards.length - 1];
    if (!customer.id || !card?.id || !card.last_digits) {
        throw new ApiError(400, "Omise ไม่ส่งข้อมูลบัตรกลับมา กรุณาลองใหม่อีกครั้ง", customer);
    }
    return card;
}

function pickNewCardFromCustomer(customer: OmiseCustomerDTO, previousCardIds: Set<string>): OmiseCardDTO {
    const cards = customer.cards?.data ?? [];
    const card = [...cards].reverse().find((item) => item.id && !previousCardIds.has(item.id)) ?? cards[cards.length - 1];
    if (!customer.id || !card?.id || !card.last_digits) {
        throw new ApiError(400, "Omise ไม่ส่งข้อมูลบัตรกลับมา กรุณาลองใหม่อีกครั้ง", customer);
    }
    return card;
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

async function getExistingCustomerId(conn: PoolConnection, uId: number): Promise<string | null> {
    const [rows] = await conn.query<(RowDataPacket & { provider_customer_id: string })[]>(
        `SELECT provider_customer_id
         FROM User_payment_methods
         WHERE u_id = ? AND provider = 'omise' AND is_active = 1
         ORDER BY is_default DESC, upm_id DESC
         LIMIT 1`,
        [uId]
    );
    return rows[0]?.provider_customer_id ?? null;
}

async function getTokenCard(tokenId: string): Promise<OmiseCardDTO | null> {
    const token = await omiseVaultRequest<OmiseTokenDTO>(`/tokens/${tokenId.trim()}`, {
        method: "GET",
    });
    return token.card ?? null;
}

async function assertCardNotAlreadySaved(
    conn: PoolConnection,
    input: { u_id: number; card: OmiseCardDTO | null }
): Promise<void> {
    const fingerprint = input.card?.fingerprint?.trim();
    if (!fingerprint) return;

    const [rows] = await conn.query<(RowDataPacket & { upm_id: number; card_last4: string })[]>(
        `SELECT upm_id, card_last4
         FROM User_payment_methods
         WHERE u_id = ?
           AND provider = 'omise'
           AND is_active = 1
           AND card_fingerprint = ?
         LIMIT 1`,
        [input.u_id, fingerprint]
    );

    if (rows[0]) {
        throw new ApiError(409, `บัตรใบนี้ถูกบันทึกไว้แล้ว (ลงท้าย ${rows[0].card_last4})`);
    }
}

async function syncOmiseCustomerCards(conn: PoolConnection, uId: number, customerId: string): Promise<void> {
    const customer = await omiseRequest<OmiseCustomerDTO>(`/customers/${customerId}`, {
        method: "GET",
    });
    const cards = (customer.cards?.data ?? []).filter((card) => !card.deleted && card.id && card.last_digits);
    if (cards.length === 0) return;

    const defaultCardId = customer.default_card ?? cards[cards.length - 1]?.id ?? null;
    await conn.query(
        "UPDATE User_payment_methods SET is_default = 0, updated_at = ? WHERE u_id = ? AND provider = 'omise'",
        [new Date(), uId]
    );

    for (const card of cards) {
        await conn.query(
            `INSERT INTO User_payment_methods
                (u_id, provider, provider_customer_id, provider_card_id, card_fingerprint, card_brand, card_last4, card_name,
                 expiration_month, expiration_year, is_default, is_active, created_at, updated_at)
             VALUES (?, 'omise', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON DUPLICATE KEY UPDATE
                u_id = VALUES(u_id),
                provider_customer_id = VALUES(provider_customer_id),
                card_fingerprint = VALUES(card_fingerprint),
                card_brand = VALUES(card_brand),
                card_last4 = VALUES(card_last4),
                card_name = VALUES(card_name),
                expiration_month = VALUES(expiration_month),
                expiration_year = VALUES(expiration_year),
                is_default = VALUES(is_default),
                is_active = 1,
                deleted_at = NULL,
                updated_at = VALUES(updated_at)`,
            [
                uId,
                customer.id ?? customerId,
                card.id,
                card.fingerprint ?? null,
                card.brand ?? null,
                card.last_digits,
                card.name ?? null,
                card.expiration_month ?? null,
                card.expiration_year ?? null,
                card.id === defaultCardId ? 1 : 0,
                new Date(),
                new Date(),
            ]
        );
    }
}

async function saveOmiseCardForUser(
    conn: PoolConnection,
    input: { u_id: number; omise_token: string; make_default?: boolean }
): Promise<SavedPaymentMethodDTO> {
    await ensurePaymentMethodTable();

    const user = await getUserContact(conn, input.u_id);
    const tokenCard = await getTokenCard(input.omise_token);
    await assertCardNotAlreadySaved(conn, { u_id: input.u_id, card: tokenCard });

    const existingCustomerId = await getExistingCustomerId(conn, input.u_id);
    const body = new URLSearchParams();
    body.set("card", input.omise_token.trim());

    let customer: OmiseCustomerDTO;
    let previousCardIds = new Set<string>();
    if (existingCustomerId) {
        const beforeCustomer = await omiseRequest<OmiseCustomerDTO>(`/customers/${existingCustomerId}`, {
            method: "GET",
        });
        previousCardIds = new Set((beforeCustomer.cards?.data ?? []).map((card) => card.id).filter((id): id is string => Boolean(id)));
        customer = await omiseRequest<OmiseCustomerDTO>(`/customers/${existingCustomerId}`, {
            method: "PATCH",
            body,
        });
    } else {
        body.set("description", `Arcana buyer #${input.u_id}`);
        if (user.u_email) body.set("email", user.u_email);
        body.set("metadata[user_id]", String(input.u_id));
        if (user.u_username) body.set("metadata[username]", user.u_username);

        customer = await omiseRequest<OmiseCustomerDTO>("/customers", {
            method: "POST",
            body,
        });
    }

    const card = existingCustomerId ? pickNewCardFromCustomer(customer, previousCardIds) : pickCardFromCustomer(customer);
    const shouldDefault = input.make_default ?? !existingCustomerId;

    if (shouldDefault) {
        await conn.query(
            "UPDATE User_payment_methods SET is_default = 0, updated_at = ? WHERE u_id = ? AND provider = 'omise'",
            [new Date(), input.u_id]
        );
    }

    const [result] = await conn.query<ResultSetHeader>(
        `INSERT INTO User_payment_methods
            (u_id, provider, provider_customer_id, provider_card_id, card_fingerprint, card_brand, card_last4, card_name,
             expiration_month, expiration_year, is_default, is_active, created_at, updated_at)
         VALUES (?, 'omise', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE
            u_id = VALUES(u_id),
            provider_customer_id = VALUES(provider_customer_id),
            card_fingerprint = VALUES(card_fingerprint),
            card_brand = VALUES(card_brand),
            card_last4 = VALUES(card_last4),
            card_name = VALUES(card_name),
            expiration_month = VALUES(expiration_month),
            expiration_year = VALUES(expiration_year),
            is_default = VALUES(is_default),
            is_active = 1,
            deleted_at = NULL,
            upm_id = LAST_INSERT_ID(upm_id),
            updated_at = VALUES(updated_at)`,
        [
            input.u_id,
            customer.id,
            card.id,
            card.fingerprint ?? tokenCard?.fingerprint ?? null,
            card.brand ?? null,
            card.last_digits,
            card.name ?? null,
            card.expiration_month ?? null,
            card.expiration_year ?? null,
            shouldDefault ? 1 : 0,
            new Date(),
            new Date(),
        ]
    );

    if (!customer.id) throw new ApiError(400, "Omise ไม่ส่ง customer id กลับมา", customer);
    await syncOmiseCustomerCards(conn, input.u_id, customer.id);

    return getSavedPaymentMethodById(conn, input.u_id, result.insertId);
}

async function getSavedPaymentMethodById(
    conn: PoolConnection,
    uId: number,
    paymentMethodId: number
): Promise<SavedPaymentMethodDTO> {
    await ensurePaymentMethodTable();

    const [rows] = await conn.query<SavedPaymentMethodRow[]>(
        `SELECT *
         FROM User_payment_methods
         WHERE upm_id = ? AND u_id = ? AND provider = 'omise' AND is_active = 1
         LIMIT 1`,
        [paymentMethodId, uId]
    );

    const method = rows[0];
    if (!method) throw new ApiError(404, "ไม่พบบัตรที่บันทึกไว้");
    return toPaymentMethodDTO(method);
}

export async function listSavedPaymentMethods(uId: number): Promise<SavedPaymentMethodDTO[]> {
    await ensurePaymentMethodTable();

    const conn = await pool.getConnection();
    try {
        const customerId = await getExistingCustomerId(conn, uId);
        if (customerId) await syncOmiseCustomerCards(conn, uId, customerId);
    } finally {
        conn.release();
    }

    const [rows] = await pool.query<SavedPaymentMethodRow[]>(
        `SELECT *
         FROM User_payment_methods
         WHERE u_id = ? AND provider = 'omise' AND is_active = 1
         ORDER BY is_default DESC, upm_id DESC`,
        [uId]
    );

    return rows.map(toPaymentMethodDTO);
}

export async function addSavedPaymentMethod(input: {
    u_id: number;
    omise_token: string;
    make_default?: boolean;
}): Promise<SavedPaymentMethodDTO> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const method = await saveOmiseCardForUser(conn, {
            u_id: input.u_id,
            omise_token: input.omise_token,
            ...(input.make_default !== undefined ? { make_default: input.make_default } : {}),
        });
        await conn.commit();
        return method;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function setDefaultPaymentMethod(uId: number, paymentMethodId: number): Promise<SavedPaymentMethodDTO> {
    await ensurePaymentMethodTable();

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const method = await getSavedPaymentMethodById(conn, uId, paymentMethodId);

        const body = new URLSearchParams();
        body.set("default_card", method.provider_card_id);
        await omiseRequest<OmiseCustomerDTO>(`/customers/${method.provider_customer_id}`, {
            method: "PATCH",
            body,
        });

        await conn.query(
            "UPDATE User_payment_methods SET is_default = 0, updated_at = ? WHERE u_id = ? AND provider = 'omise'",
            [new Date(), uId]
        );
        await conn.query(
            "UPDATE User_payment_methods SET is_default = 1, updated_at = ? WHERE upm_id = ? AND u_id = ?",
            [new Date(), paymentMethodId, uId]
        );

        await conn.commit();
        return getSavedPaymentMethodById(conn, uId, paymentMethodId);
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function deleteSavedPaymentMethod(uId: number, paymentMethodId: number): Promise<{ deleted: true }> {
    await ensurePaymentMethodTable();

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const method = await getSavedPaymentMethodById(conn, uId, paymentMethodId);

        await omiseRequest<OmiseCardDTO>(`/customers/${method.provider_customer_id}/cards/${method.provider_card_id}`, {
            method: "DELETE",
        });

        await conn.query(
            "UPDATE User_payment_methods SET is_active = 0, is_default = 0, deleted_at = ?, updated_at = ? WHERE upm_id = ? AND u_id = ?",
            [new Date(), new Date(), paymentMethodId, uId]
        );

        const [defaultRows] = await conn.query<(RowDataPacket & { cnt: number })[]>(
            "SELECT COUNT(*) AS cnt FROM User_payment_methods WHERE u_id = ? AND provider = 'omise' AND is_active = 1 AND is_default = 1",
            [uId]
        );
        if (Number(defaultRows[0]?.cnt ?? 0) === 0) {
            await conn.query(
                `UPDATE User_payment_methods
                 SET is_default = 1, updated_at = ?
                 WHERE upm_id = (
                    SELECT upm_id FROM (
                        SELECT upm_id
                        FROM User_payment_methods
                        WHERE u_id = ? AND provider = 'omise' AND is_active = 1
                        ORDER BY upm_id DESC
                        LIMIT 1
                    ) AS next_default
                 )`,
                [new Date(), uId]
            );
        }

        await conn.commit();
        return { deleted: true };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function createOmiseCharge(input: {
    paymentMethod: OmiseChargeInput["payment_method"];
    token?: string;
    source?: string;
    customer?: string;
    card?: string;
    amountSatang: number;
    description: string;
    metadata: Record<string, string>;
}): Promise<OmiseChargeResponse> {
    const body = new URLSearchParams();
    body.set("amount", String(input.amountSatang));
    body.set("currency", "thb");
    body.set("description", input.description);

    if (input.paymentMethod === "card") {
        if (input.customer && input.card) {
            body.set("customer", input.customer);
            body.set("card", input.card);
        } else {
            if (!input.token) throw new ApiError(400, "ไม่พบ token สำหรับชำระเงินด้วยบัตร");
            body.set("card", input.token);
        }
    } else if (input.paymentMethod === "promptpay") {
        const source = input.source?.trim() || await createOmisePromptPaySource(input.amountSatang);
        body.set("source", source);
    } else {
        const source = input.source?.trim() || await createOmiseMobileBankingSource(input.paymentMethod, input.amountSatang);
        body.set("source", source);
        body.set("return_uri", env.OMISE_RETURN_URI || "https://arcana-callback.local/omise");
    }

    for (const [key, value] of Object.entries(input.metadata)) {
        body.set(`metadata[${key}]`, value);
    }

    const res = await fetch("https://api.omise.co/charges", {
        method: "POST",
        headers: {
            Authorization: omiseAuthHeader(),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
    });

    const payload = await res.json() as OmiseChargeResponse & { message?: string };
    if (!res.ok) {
        throw new ApiError(400, payload.message || "ชำระเงินผ่าน Omise ไม่สำเร็จ", payload);
    }

    return payload;
}

export async function createOmiseRefund(input: {
    chargeId: string;
    amount: number;
    metadata?: Record<string, string>;
}): Promise<OmiseRefundResponse> {
    if (!input.chargeId.trim()) throw new ApiError(400, "ไม่พบ payment reference สำหรับคืนเงิน");
    if (input.amount <= 0) throw new ApiError(400, "ยอดคืนเงินไม่ถูกต้อง");

    const body = new URLSearchParams();
    body.set("amount", String(toSatang(input.amount)));
    for (const [key, value] of Object.entries(input.metadata ?? {})) {
        body.set(`metadata[${key}]`, value);
    }

    return omiseRequest<OmiseRefundResponse>(`/charges/${input.chargeId.trim()}/refunds`, {
        method: "POST",
        body,
    });
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
         WHERE o.u_id = ?
           AND o.or_id IN (?)
         FOR UPDATE`,
        [uId, orderIds]
    );

    if (rows.length !== orderIds.length) {
        throw new ApiError(404, "พบคำสั่งซื้อบางรายการที่ไม่ใช่ของผู้ใช้ หรือไม่มีอยู่จริง");
    }

    const notPending = rows.find((order) => {
        return !BUYER_PAYABLE_STATUS_CODES.includes(order.status_code as OrderStatusCode);
    });
    if (notPending) {
        throw new ApiError(400, `คำสั่งซื้อ ${notPending.order_no} ไม่ได้อยู่ในสถานะรอชำระเงิน`);
    }

    const now = Date.now();
    const expired = rows.find((order) => {
        return order.payment_expires_at && new Date(order.payment_expires_at).getTime() <= now;
    });
    if (expired) {
        throw new ApiError(400, `คำสั่งซื้อ ${expired.order_no} หมดเวลาชำระเงินแล้ว`);
    }

    return rows;
}

function emitPaidOrderChanges(rows: PaymentOrderSocketRow[]) {
    if (!rows.length) return;

    try {
        const io = getIO();
        const orderIds = rows.map((row) => Number(row.or_id));
        const userIds = [...new Set(rows.map((row) => Number(row.u_id)).filter(Boolean))];

        for (const storeId of new Set(rows.map((row) => Number(row.st_id)).filter(Boolean))) {
            io.to(`STORE_${storeId}`).emit("order:changed", {
                event: "order:paid",
                order_ids: orderIds,
                status_code: "CONFIRMED",
            });
            io.to(`STORE_${storeId}`).emit("order:paid", {
                event: "order:paid",
                order_ids: orderIds,
                status_code: "CONFIRMED",
            });
        }

        for (const userId of userIds) {
            io.to(`USER_${userId}`).emit("payment:confirmed", { order_ids: orderIds });
            io.to(`USER_${userId}`).emit("order:changed", {
                event: "order:paid",
                order_ids: orderIds,
                status_code: "CONFIRMED",
            });
        }
    } catch {
        // Socket อาจไม่ได้ init (เช่น ตอน test) — ไม่ต้อง throw เพราะ DB อัพเดทสำเร็จแล้ว
    }
}

export async function chargeAndRecordPayment(
    conn: PoolConnection,
    input: Omit<OmiseChargeInput, "order_ids"> & { orders: PaymentOrderSummary[]; throwOnFailed?: boolean }
): Promise<PaymentResultDTO> {
    if (input.orders.length === 0) throw new ApiError(400, "กรุณาระบุคำสั่งซื้อที่ต้องชำระเงิน");
    if (input.payment_method === "card" && !input.omise_token?.trim() && !input.saved_payment_method_id) {
        throw new ApiError(400, "ไม่พบ token สำหรับชำระเงินด้วยบัตร");
    }

    const orders = input.orders;
    const orderIds = orders.map((order) => order.or_id);
    const amountTotal = roundMoney(orders.reduce((sum, order) => sum + Number(order.grand_total ?? 0), 0));
    if (amountTotal <= 0) throw new ApiError(400, "ยอดชำระเงินไม่ถูกต้อง");

    const savedCard = input.payment_method === "card" && input.saved_payment_method_id
        ? await getSavedPaymentMethodById(conn, input.u_id, input.saved_payment_method_id)
        : input.payment_method === "card" && input.save_card && input.omise_token
            ? await saveOmiseCardForUser(conn, {
                u_id: input.u_id,
                omise_token: input.omise_token,
                make_default: true,
            })
            : null;

    const charge = await createOmiseCharge({
        paymentMethod: input.payment_method,
        ...(savedCard ? { customer: savedCard.provider_customer_id, card: savedCard.provider_card_id } : {}),
        ...(!savedCard && input.omise_token ? { token: input.omise_token.trim() } : {}),
        ...(input.omise_source ? { source: input.omise_source.trim() } : {}),
        amountSatang: toSatang(amountTotal),
        description: `Arcana orders ${orders.map((order) => order.order_no).join(", ")}`,
        metadata: {
            order_ids: orders.map((order) => order.or_id).join(","),
            order_nos: orders.map((order) => order.order_no).join(","),
            user_id: String(input.u_id),
            payment_method: input.payment_method,
            ...(savedCard ? { payment_method_id: String(savedCard.upm_id) } : {}),
        },
    });

    const isPaid = charge.paid === true || charge.status === "successful";
    const isPending = charge.status === "pending";
    const paymentStatus: PaymentResultDTO["payment_status"] = isPaid ? "paid" : isPending ? "pending" : "failed";

    if (paymentStatus === "failed" && input.throwOnFailed) {
        const fallback = input.payment_method === "card"
            ? "ชำระเงินไม่สำเร็จ กรุณาตรวจสอบข้อมูลบัตรแล้วลองใหม่"
            : "ชำระเงินผ่านธนาคารไม่สำเร็จ กรุณาลองใหม่อีกครั้ง";
        throw new ApiError(400, buildOmiseFailureMessage(charge, fallback), charge);
    }

    const paymentNo = buildPaymentNo();

    // บันทึกผลชำระเงินก่อน แล้วค่อยผูกกับ order ผ่าน Payment_orders
    const [payRes] = await conn.query<ResultSetHeader>(
        `INSERT INTO Payments
                (payment_no, amount_total, payment_method, payment_status, payment_ref, paid_at, created_at, u_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            paymentNo,
            amountTotal.toFixed(2),
            toPaymentRecordMethod(input.payment_method),
            paymentStatus,
            charge.id ?? null,
            isPaid ? new Date() : null,
            new Date(),
            input.u_id,
        ]
    );

    const payId = payRes.insertId;
    const paymentOrderRows = orders.map((order) => [payId, order.or_id, new Date()]);
    await conn.query(
        "INSERT INTO Payment_orders (pay_id, or_id, created_at) VALUES ?",
        [paymentOrderRows]
    );

    if (isPaid) {
        // ตัด stock จริงเฉพาะตอน Omise ยืนยันว่าชำระเงินสำเร็จแล้ว
        await consumeReservationsForOrders(conn, orderIds);

        await setOrdersStatus(conn, orderIds, "CONFIRMED");
    }

    return {
        pay_id: payId,
        payment_no: paymentNo,
        payment_status: paymentStatus,
        payment_ref: charge.id ?? null,
        amount_total: amountTotal,
        authorize_uri: charge.authorize_uri ?? null,
        qr_code_uri: charge.source?.scannable_code?.image?.download_uri ?? null,
        order_ids: orders.map((order) => order.or_id),
    };
}

/**
 * handleChargeComplete — เรียกโดย Omise webhook เมื่อ charge เปลี่ยนสถานะเป็น successful หรือ failed
 *
 * ใช้สำหรับ PromptPay เป็นหลัก เพราะ card charge จะ resolve ทันทีตอนสร้าง
 * ส่วน PromptPay ต้องรอลูกค้าสแกน QR ก่อน Omise จึงส่ง webhook กลับมาทีหลัง
 *
 * ฟังก์ชันนี้ออกแบบให้ idempotent: ถ้า payment อัพเดทไปแล้วจะ skip ทันที
 */
export async function handleChargeComplete(
    chargeId: string,
    chargeStatus: string,
    chargePaid: boolean
): Promise<void> {
    // ตรวจสอบว่า charge สำเร็จหรือล้มเหลว — สถานะอื่น (เช่น pending) ยังไม่ต้องทำอะไร
    const isSuccessful = chargePaid === true || chargeStatus === "successful";
    const isFailed = chargeStatus === "failed";

    if (!isSuccessful && !isFailed) return;

    await ensureInventoryReservationTable();

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Lock payment record เพื่อป้องกัน race condition กรณี webhook ถูกส่งซ้ำ
        // ดึง u_id ไว้ด้วยเพื่อใช้ emit socket หลัง commit
        const [payRows] = await conn.query<(RowDataPacket & { pay_id: number; payment_status: string; u_id: number })[]>(
            "SELECT pay_id, payment_status, u_id FROM Payments WHERE payment_ref = ? LIMIT 1 FOR UPDATE",
            [chargeId]
        );

        // ตรวจ undefined โดยตรงเพื่อให้ TypeScript narrow type ได้ (length check ทำไม่ได้)
        const payment = payRows[0];
        if (!payment) {
            // ไม่พบ payment ที่ผูกกับ charge นี้ — อาจเกิดจาก charge ถูกสร้างนอกระบบ
            await conn.rollback();
            return;
        }

        // Idempotent guard: ถ้าเคยอัพเดทแล้วไม่ต้องทำซ้ำ
        if (payment.payment_status !== "pending") {
            await conn.rollback();
            return;
        }

        // อัพเดทสถานะ payment และบันทึกเวลาที่ชำระเงิน
        await conn.query(
            "UPDATE Payments SET payment_status = ?, paid_at = ? WHERE pay_id = ?",
            [
                isSuccessful ? "paid" : "failed",
                isSuccessful ? new Date() : null,
                payment.pay_id,
            ]
        );

        let confirmedOrders: PaymentOrderSocketRow[] = [];

        if (isSuccessful) {
            // ดึง order IDs ทั้งหมดที่ผูกกับ payment นี้
            const [orderRows] = await conn.query<PaymentOrderSocketRow[]>(
                `SELECT o.or_id, o.order_no, o.u_id, o.st_id, o.grand_total
                 FROM Payment_orders po
                 INNER JOIN Orders o ON o.or_id = po.or_id
                 WHERE po.pay_id = ?`,
                [payment.pay_id]
            );
            confirmedOrders = orderRows;
            const confirmedOrderIds = confirmedOrders.map((row) => Number(row.or_id));

            if (confirmedOrderIds.length > 0) {
                // ตัด stock และเปลี่ยนสถานะ order เป็น CONFIRMED เหมือนกับ card payment ที่สำเร็จทันที
                await consumeReservationsForOrders(conn, confirmedOrderIds);
                await setOrdersStatus(conn, confirmedOrderIds, "CONFIRMED");
            }
        }

        await conn.commit();

        // แจ้ง frontend ผ่าน Socket.IO หลัง commit สำเร็จแล้วเท่านั้น
        // ส่งไปที่ห้อง USER_<id> เพื่อให้เฉพาะลูกค้าคนนั้นรับ event
        if (isSuccessful && confirmedOrders.length > 0) {
            emitPaidOrderChanges(confirmedOrders);

            // บันทึก notification ลง DB ให้ร้านค้าและลูกค้าเห็นย้อนหลังได้
            // (checkoutOrder ทำแล้วสำหรับ card payment — webhook path นี้ครอบคลุม PromptPay และ 3DS)
            for (const order of confirmedOrders) {
                const totalLabel = order.grand_total != null
                    ? ` ยอด ${Number(order.grand_total).toLocaleString("th-TH")} บาท`
                    : "";
                const orderNo = order.order_no ?? String(order.or_id);
                try {
                    await notificationService.CreateNotification({
                        target_type: "STORE",
                        target_id: Number(order.st_id),
                        type: "order:paid",
                        title: "ชำระเงินสำเร็จ",
                        message: `คำสั่งซื้อ ${orderNo} ชำระเงินแล้ว${totalLabel}`,
                        action_url: `/dashboard/orders?order_id=${order.or_id}`,
                        ref_type: "ORDER",
                        ref_id: Number(order.or_id),
                        priority: "HIGH",
                    });
                } catch (err) {
                    console.warn(`[payments] store notification for order ${order.or_id} failed:`, err);
                }
            }
        }
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// sync สถานะ payment ล่าสุดที่ผูกกับ order เหล่านี้ (รองรับทั้งจ่ายทีละใบและจ่ายรวมหลาย order ในบิลเดียว)
export async function syncPromptPayCharge(uId: number, orderIds: number[]): Promise<PaymentResultDTO> {
    const uniqueOrderIds = [...new Set(orderIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (uniqueOrderIds.length === 0) throw new ApiError(400, "กรุณาระบุคำสั่งซื้อที่ต้องการตรวจสอบการชำระเงิน");

    const [rows] = await pool.query<(RowDataPacket & {
        pay_id: number;
        payment_no: string;
        payment_status: PaymentResultDTO["payment_status"];
        payment_ref: string | null;
        amount_total: number;
    })[]>(
        `SELECT p.pay_id, p.payment_no, p.payment_status, p.payment_ref, p.amount_total
         FROM Payments p
         INNER JOIN Payment_orders po ON po.pay_id = p.pay_id
         INNER JOIN Orders o ON o.or_id = po.or_id
         WHERE o.or_id IN (?)
           AND o.u_id = ?
           AND p.payment_method IN ('omise_promptpay', 'omise_mobile_banking_kbank', 'omise_mobile_banking_scb')
         ORDER BY p.pay_id DESC
         LIMIT 1`,
        [uniqueOrderIds, uId]
    );

    const payment = rows[0];
    if (!payment) throw new ApiError(404, "ไม่พบรายการชำระเงิน Omise ของคำสั่งซื้อนี้");

    if (payment.payment_status === "pending" && payment.payment_ref) {
        const charge = await omiseRequest<OmiseChargeResponse>(`/charges/${payment.payment_ref}`, {
            method: "GET",
        });
        await handleChargeComplete(payment.payment_ref, charge.status ?? "", charge.paid === true);
    }

    const [updatedRows] = await pool.query<(RowDataPacket & {
        pay_id: number;
        payment_no: string;
        payment_status: PaymentResultDTO["payment_status"];
        payment_ref: string | null;
        amount_total: number;
    })[]>(
        `SELECT p.pay_id, p.payment_no, p.payment_status, p.payment_ref, p.amount_total
         FROM Payments p
         WHERE p.pay_id = ?
         LIMIT 1`,
        [payment.pay_id]
    );

    const updated = updatedRows[0] ?? payment;

    // ดึง order_ids ทั้งหมดที่ผูกกับ payment นี้จริงๆ เผื่อ payment รวมหลาย order มากกว่าที่ caller ส่งมา
    const [orderRows] = await pool.query<(RowDataPacket & { or_id: number })[]>(
        "SELECT or_id FROM Payment_orders WHERE pay_id = ?",
        [payment.pay_id]
    );

    return {
        pay_id: Number(updated.pay_id),
        payment_no: updated.payment_no,
        payment_status: updated.payment_status,
        payment_ref: updated.payment_ref,
        amount_total: Number(updated.amount_total),
        order_ids: orderRows.map((row) => Number(row.or_id)),
    };
}

export async function chargeOrdersWithOmise(input: OmiseChargeInput): Promise<PaymentResultDTO> {
    await ensureInventoryReservationTable();

    const orderIds = [...new Set(input.order_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (orderIds.length === 0) throw new ApiError(400, "กรุณาระบุคำสั่งซื้อที่ต้องชำระเงิน");

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const orders = await getPayableOrdersForUpdate(conn, input.u_id, orderIds);
        const payment = await chargeAndRecordPayment(conn, {
            u_id: input.u_id,
            payment_method: input.payment_method,
            ...(input.omise_token ? { omise_token: input.omise_token } : {}),
            ...(input.omise_source ? { omise_source: input.omise_source } : {}),
            ...(input.saved_payment_method_id ? { saved_payment_method_id: input.saved_payment_method_id } : {}),
            ...(input.save_card ? { save_card: true } : {}),
            ...(input.payment_method !== "promptpay" ? { throwOnFailed: true } : {}),
            orders,
        });

        await conn.commit();
        if (payment.payment_status === "paid") {
            emitPaidOrderChanges(orders);
        }
        return payment;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}
