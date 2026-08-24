import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import type {
    AvailableCouponDTO,
    CouponDTO,
    CouponProductDTO,
    CreateCouponInput,
    RedeemCouponInput,
    UpdateCouponInput,
    UserCouponDTO,
    ValidateCouponInput,
    ValidateCouponResult,
} from "./type.js";

type CouponRow = RowDataPacket & Omit<CouponDTO, "product_ids"> & {
    product_ids: string | null;
};

type AvailableCouponRow = CouponRow & {
    user_coupon_status: string | null;
};

type CartCouponRow = RowDataPacket & {
    p_id: number;
    line_total: number;
};

const couponProductIdsSql = `(
    SELECT GROUP_CONCAT(cp.p_id ORDER BY cp.p_id ASC)
    FROM CouponProducts cp
    WHERE cp.co_id = c.co_id
)`;

const couponWebsiteKeySql = `COALESCE((
    SELECT
        CASE
            WHEN COUNT(DISTINCT p.ctl_id) = 1 AND MIN(p.ctl_id) = 1 THEN 'arcana'
            WHEN COUNT(DISTINCT p.ctl_id) = 1 AND MIN(p.ctl_id) = 2 THEN 'deadstock'
            ELSE 'combined'
        END
    FROM Products p
    WHERE (
        EXISTS (
            SELECT 1
            FROM CouponProducts cp_exists
            WHERE cp_exists.co_id = c.co_id
        )
        AND p.p_id IN (
            SELECT cp.p_id
            FROM CouponProducts cp
            WHERE cp.co_id = c.co_id
        )
    )
    OR (
        NOT EXISTS (
            SELECT 1
            FROM CouponProducts cp_none
            WHERE cp_none.co_id = c.co_id
        )
        AND p.st_id = c.st_id
    )
), 'combined')`;

function toNumber(value: unknown, fallback = 0): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function toDbBool(value: unknown, fallback = 1): 0 | 1 {
    if (value === undefined || value === null || value === "") return fallback as 0 | 1;
    const v = String(value).trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes" || v === "on" ? 1 : 0;
}

function normalizeProductIds(productIds?: number[]): number[] {
    if (!Array.isArray(productIds)) return [];
    return [...new Set(productIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

// แปลง row จาก MySQL ให้เป็น DTO ที่ frontend ใช้ง่าย และแปลง GROUP_CONCAT เป็น array
function mapCoupon(row: CouponRow): CouponDTO {
    const productIds = row.product_ids
        ? row.product_ids.split(",").map(Number).filter((id) => Number.isInteger(id))
        : [];

    return {
        co_id: Number(row.co_id),
        co_code: String(row.co_code),
        website_key: row.website_key === "arcana" || row.website_key === "deadstock" ? row.website_key : "combined",
        discount_type: row.discount_type,
        discount_value: toNumber(row.discount_value),
        max_discount_amount: row.max_discount_amount === null ? null : toNumber(row.max_discount_amount),
        co_datetime_start: String(row.co_datetime_start),
        co_datetime_end: String(row.co_datetime_end),
        create_at: String(row.create_at),
        update_at: row.update_at === null ? null : String(row.update_at),
        min_order_amount: toNumber(row.min_order_amount),
        usage_limit_total: row.usage_limit_total === null ? null : Number(row.usage_limit_total),
        usage_limit_per_user: Number(row.usage_limit_per_user),
        active: Number(row.active) === 1 ? 1 : 0,
        used_count: Number(row.used_count),
        st_id: Number(row.st_id),
        product_ids: productIds,
    };
}

// คำนวณส่วนลดจริง โดยกันไม่ให้ลดเกิน subtotal และรองรับ max discount ของคูปอง %
function calculateDiscount(coupon: CouponDTO, subtotal: number): number {
    if (subtotal <= 0) return 0;

    const rawDiscount = coupon.discount_type === "percent"
        ? subtotal * (coupon.discount_value / 100)
        : coupon.discount_value;

    const cappedDiscount = coupon.max_discount_amount !== null
        ? Math.min(rawDiscount, coupon.max_discount_amount)
        : rawDiscount;

    return Math.round(Math.min(cappedDiscount, subtotal) * 100) / 100;
}

// sync รายการสินค้าที่คูปองใช้ได้: ล้าง mapping เดิมแล้ว insert ชุดใหม่ใน transaction เดียวกัน
async function syncCouponProducts(conn: PoolConnection, coId: number, productIds: number[]): Promise<void> {
    await conn.query("DELETE FROM CouponProducts WHERE co_id = ?", [coId]);

    if (productIds.length === 0) return;

    const rows = productIds.map((pId) => [coId, pId]);
    await conn.query("INSERT INTO CouponProducts (co_id, p_id) VALUES ?", [rows]);
}

// ใช้ตอน checkout เพื่อ lock row คูปอง กัน used_count ถูกใช้พร้อมกันจนเกิน limit
async function getCouponByCodeForUpdate(conn: PoolConnection, coCode: string): Promise<CouponDTO | null> {
    const [rows] = await conn.query<CouponRow[]>(
        `
        SELECT
            c.*,
            ${couponProductIdsSql} AS product_ids,
            ${couponWebsiteKeySql} AS website_key
        FROM Coupon c
        WHERE c.co_code = ?
        FOR UPDATE
        `,
        [coCode]
    );

    return rows[0] ? mapCoupon(rows[0]) : null;
}

// ดึงเฉพาะสินค้าใน active cart ที่ลูกค้าเลือกไว้ เพื่อใช้เป็นฐานคำนวณคูปอง
async function getActiveCartRows(conn: PoolConnection, uId: number, stId?: number): Promise<CartCouponRow[]> {
    const params: number[] = [uId];
    const storeSql = stId ? "AND p.st_id = ?" : "";
    if (stId) params.push(stId);

    const [rows] = await conn.query<CartCouponRow[]>(
        `
        SELECT
            p.p_id,
            ci.line_total
        FROM Carts c
        INNER JOIN Cart_items ci ON ci.cart_id = c.cart_id
        INNER JOIN ProductVariants pv ON pv.pv_id = ci.pv_id
        INNER JOIN Products p ON p.p_id = pv.p_id
        WHERE c.u_id = ?
          AND c.status = 'active'
          AND c.cart_id = (
              SELECT active_cart.cart_id
              FROM Carts active_cart
              WHERE active_cart.u_id = ?
                AND active_cart.status = 'active'
              ORDER BY active_cart.cart_id DESC
              LIMIT 1
          )
          AND ci.is_selected = 1
          ${storeSql}
        `,
        [uId, ...params]
    );

    return rows;
}

// ตรวจเงื่อนไขคูปองทั้งหมดในที่เดียว: สถานะ, เวลา, limit, สินค้าที่ใช้ได้, ยอดขั้นต่ำ และยอดลด
async function validateCouponWithConnection(
    conn: PoolConnection,
    input: ValidateCouponInput,
    lockCoupon = false
): Promise<ValidateCouponResult> {
    const coupon = lockCoupon
        ? await getCouponByCodeForUpdate(conn, input.co_code)
        : await getCouponByCode(input.co_code);

    if (!coupon) throw new ApiError(404, "ไม่พบคูปอง");
    if (coupon.active !== 1) throw new ApiError(400, "คูปองนี้ถูกปิดใช้งาน");
    if (input.st_id && coupon.st_id !== input.st_id) {
        throw new ApiError(400, "คูปองนี้ใช้ได้เฉพาะร้านที่ออกคูปองเท่านั้น");
    }

    const now = new Date();
    if (now < new Date(coupon.co_datetime_start)) throw new ApiError(400, "คูปองยังไม่ถึงเวลาใช้งาน");
    if (now > new Date(coupon.co_datetime_end)) throw new ApiError(400, "คูปองหมดอายุแล้ว");

    if (coupon.usage_limit_total !== null && coupon.used_count >= coupon.usage_limit_total) {
        throw new ApiError(400, "คูปองถูกใช้ครบจำนวนแล้ว");
    }

    const [claimedRows] = await conn.query<(RowDataPacket & { status: string })[]>(
        "SELECT status FROM UserCoupons WHERE co_id = ? AND u_id = ? LIMIT 1",
        [coupon.co_id, input.u_id]
    );

    const claimedCoupon = claimedRows[0];
    if (!claimedCoupon) {
        throw new ApiError(400, "กรุณาเก็บคูปองก่อนใช้งาน");
    }

    if (claimedCoupon.status !== "claimed") {
        throw new ApiError(400, "คูปองนี้ไม่พร้อมใช้งาน");
    }

    // นับจาก CouponRedemptions เป็น source of truth สำหรับ usage ต่อ user
    const [userUsageRows] = await conn.query<(RowDataPacket & { used_count: number })[]>(
        "SELECT COUNT(*) AS used_count FROM CouponRedemptions WHERE co_id = ? AND u_id = ?",
        [coupon.co_id, input.u_id]
    );

    const userUsedCount = Number(userUsageRows[0]?.used_count ?? 0);
    if (userUsedCount >= coupon.usage_limit_per_user) {
        throw new ApiError(400, "คุณใช้คูปองนี้ครบจำนวนแล้ว");
    }

    const cartRows = await getActiveCartRows(conn, input.u_id, input.st_id);
    if (cartRows.length === 0) throw new ApiError(400, "ไม่มีสินค้าในตะกร้าที่เลือกไว้");

    // ถ้าไม่ได้ผูกสินค้าไว้ แปลว่าคูปองใช้ได้กับทุกสินค้าในตะกร้า
    const allowedProductSet = new Set(coupon.product_ids);
    const applicableRows = coupon.product_ids.length > 0
        ? cartRows.filter((row) => allowedProductSet.has(Number(row.p_id)))
        : cartRows;

    if (applicableRows.length === 0) {
        throw new ApiError(400, "คูปองนี้ใช้กับสินค้าในตะกร้าไม่ได้");
    }

    const subtotal = Math.round(applicableRows.reduce((sum, row) => sum + toNumber(row.line_total), 0) * 100) / 100;
    if (subtotal < coupon.min_order_amount) {
        throw new ApiError(400, `ยอดขั้นต่ำสำหรับคูปองนี้คือ ${coupon.min_order_amount}`);
    }

    const discount = calculateDiscount(coupon, subtotal);

    return {
        coupon,
        subtotal_amount: subtotal,
        discount_amount: discount,
        grand_total_amount: Math.round((subtotal - discount) * 100) / 100,
    };
}

export async function listCoupons(stId: number): Promise<CouponDTO[]> {
    const [rows] = await pool.query<CouponRow[]>(
        `
        SELECT
            c.*,
            ${couponProductIdsSql} AS product_ids,
            ${couponWebsiteKeySql} AS website_key
        FROM Coupon c
        WHERE c.st_id = ?
        ORDER BY c.co_id DESC
        `,
        [stId]
    );

    return rows.map(mapCoupon);
}

export async function listAvailableCoupons(uId?: number): Promise<AvailableCouponDTO[]> {
    const params: number[] = [];
    const userStatusSql = uId
        ? `(
                SELECT uc.status
                FROM UserCoupons uc
                WHERE uc.co_id = c.co_id
                  AND uc.u_id = ?
                LIMIT 1
            )`
        : "NULL";

    if (uId) params.push(uId);

    const [rows] = await pool.query<AvailableCouponRow[]>(
        `
        SELECT
            c.*,
            ${couponProductIdsSql} AS product_ids,
            ${couponWebsiteKeySql} AS website_key,
            ${userStatusSql} AS user_coupon_status
        FROM Coupon c
        WHERE c.active = 1
          AND c.co_datetime_end >= NOW()
          AND (c.usage_limit_total IS NULL OR c.used_count < c.usage_limit_total)
        ORDER BY c.co_datetime_end ASC, c.co_id DESC
        `,
        params
    );

    return rows.map((row) => {
        const coupon = mapCoupon(row);
        const status = row.user_coupon_status as AvailableCouponDTO["user_coupon_status"];

        return {
            ...coupon,
            is_claimed: status !== null,
            user_coupon_status: status,
        };
    });
}

export async function getCouponById(coId: number, stId?: number): Promise<CouponDTO | null> {
    const params: Array<number> = [coId];
    let storeSql = "";

    if (stId) {
        storeSql = "AND c.st_id = ?";
        params.push(stId);
    }

    const [rows] = await pool.query<CouponRow[]>(
        `
        SELECT
            c.*,
            ${couponProductIdsSql} AS product_ids,
            ${couponWebsiteKeySql} AS website_key
        FROM Coupon c
        WHERE c.co_id = ?
        ${storeSql}
        LIMIT 1
        `,
        params
    );

    return rows[0] ? mapCoupon(rows[0]) : null;
}

export async function getCouponByCode(coCode: string): Promise<CouponDTO | null> {
    const [rows] = await pool.query<CouponRow[]>(
        `
        SELECT
            c.*,
            ${couponProductIdsSql} AS product_ids,
            ${couponWebsiteKeySql} AS website_key
        FROM Coupon c
        WHERE c.co_code = ?
        LIMIT 1
        `,
        [coCode]
    );

    return rows[0] ? mapCoupon(rows[0]) : null;
}

export async function listCouponProducts(coId: number, stId: number): Promise<CouponProductDTO[]> {
    const coupon = await getCouponById(coId, stId);
    if (!coupon) throw new ApiError(404, CommonMessages.notFound);

    const [rows] = await pool.query<(RowDataPacket & CouponProductDTO)[]>(
        `
        SELECT
            cp.co_id,
            cp.p_id,
            p.p_code,
            pl.p_name
        FROM CouponProducts cp
        INNER JOIN Products p ON p.p_id = cp.p_id
        LEFT JOIN ProductLangs pl ON pl.p_id = p.p_id AND pl.lg_code = 'th'
        WHERE cp.co_id = ?
        ORDER BY cp.p_id ASC
        `,
        [coId]
    );

    return rows;
}

export async function listAvailableCouponProducts(coId: number): Promise<CouponProductDTO[]> {
    const coupon = await getCouponById(coId);
    if (!coupon) throw new ApiError(404, "ไม่พบคูปอง");
    if (coupon.active !== 1) throw new ApiError(400, "คูปองนี้ถูกปิดใช้งาน");

    const now = new Date();
    if (now > new Date(coupon.co_datetime_end)) throw new ApiError(400, "คูปองหมดอายุแล้ว");

    const [rows] = await pool.query<(RowDataPacket & CouponProductDTO)[]>(
        `
        SELECT
            cp.co_id,
            cp.p_id,
            p.p_code,
            pl.p_name
        FROM CouponProducts cp
        INNER JOIN Products p ON p.p_id = cp.p_id
        LEFT JOIN ProductLangs pl ON pl.p_id = p.p_id AND pl.lg_code = 'th'
        WHERE cp.co_id = ?
        ORDER BY pl.p_name ASC, p.p_code ASC
        `,
        [coId]
    );

    return rows;
}

export async function createCoupon(input: CreateCouponInput): Promise<number> {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        // Coupon กับ CouponProducts ต้อง commit/rollback พร้อมกัน เพื่อไม่ให้คูปองหลุด mapping
        const productIds = normalizeProductIds(input.product_ids);
        const [res] = await conn.query<ResultSetHeader>(
            "INSERT INTO Coupon SET ?",
            [{
                co_code: input.co_code.trim(),
                discount_type: input.discount_type,
                discount_value: input.discount_value,
                max_discount_amount: input.max_discount_amount ?? null,
                co_datetime_start: input.co_datetime_start,
                co_datetime_end: input.co_datetime_end,
                min_order_amount: input.min_order_amount ?? 0,
                usage_limit_total: input.usage_limit_total ?? null,
                usage_limit_per_user: input.usage_limit_per_user ?? 1,
                active: toDbBool(input.active),
                used_count: 0,
                st_id: input.st_id,
            }]
        );

        await syncCouponProducts(conn, res.insertId, productIds);
        await conn.commit();
        return res.insertId;
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, "รหัสคูปองนี้ถูกใช้งานแล้ว");
        throw err;
    } finally {
        conn.release();
    }
}

export async function updateCoupon(coId: number, input: UpdateCouponInput): Promise<void> {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const [exists] = await conn.query<RowDataPacket[]>(
            "SELECT co_id FROM Coupon WHERE co_id = ? AND st_id = ? LIMIT 1",
            [coId, input.st_id]
        );

        if (!exists[0]) throw new ApiError(404, CommonMessages.notFound);

        // สร้าง object เฉพาะ field ที่ส่งมา เพื่อให้ update แบบ partial ได้
        const data: Record<string, unknown> = {};
        if (input.co_code !== undefined) data.co_code = input.co_code.trim();
        if (input.discount_type !== undefined) data.discount_type = input.discount_type;
        if (input.discount_value !== undefined) data.discount_value = input.discount_value;
        if (input.max_discount_amount !== undefined) data.max_discount_amount = input.max_discount_amount;
        if (input.co_datetime_start !== undefined) data.co_datetime_start = input.co_datetime_start;
        if (input.co_datetime_end !== undefined) data.co_datetime_end = input.co_datetime_end;
        if (input.min_order_amount !== undefined) data.min_order_amount = input.min_order_amount;
        if (input.usage_limit_total !== undefined) data.usage_limit_total = input.usage_limit_total;
        if (input.usage_limit_per_user !== undefined) data.usage_limit_per_user = input.usage_limit_per_user;
        if (input.active !== undefined) data.active = toDbBool(input.active);
        data.update_at = new Date();

        await conn.query("UPDATE Coupon SET ? WHERE co_id = ?", [data, coId]);

        if (input.product_ids !== undefined) {
            await syncCouponProducts(conn, coId, normalizeProductIds(input.product_ids));
        }

        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, "รหัสคูปองนี้ถูกใช้งานแล้ว");
        throw err;
    } finally {
        conn.release();
    }
}

export async function deleteCoupon(coId: number, stId: number): Promise<void> {
    try {
        const [res] = await pool.query<ResultSetHeader>(
            "DELETE FROM Coupon WHERE co_id = ? AND st_id = ?",
            [coId, stId]
        );

        if (res.affectedRows === 0) throw new ApiError(404, CommonMessages.notFound);
    } catch (err) {
        if (isFkConstraintError(err)) throw new ApiError(409, CommonMessages.used);
        throw err;
    }
}

export async function claimCoupon(coId: number, uId: number): Promise<void> {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const [couponRows] = await conn.query<RowDataPacket[]>(
            "SELECT co_id, active, co_datetime_start, co_datetime_end FROM Coupon WHERE co_id = ? LIMIT 1",
            [coId]
        );

        const coupon = couponRows[0];
        if (!coupon) throw new ApiError(404, "ไม่พบคูปอง");
        if (Number(coupon.active) !== 1) throw new ApiError(400, "คูปองนี้ถูกปิดใช้งาน");

        const now = new Date();
        if (now > new Date(String(coupon.co_datetime_end))) throw new ApiError(400, "คูปองหมดอายุแล้ว");

        // unique key (co_id, u_id) จะกัน user เก็บคูปองซ้ำ
        await conn.query(
            "INSERT INTO UserCoupons (co_id, u_id, claimed_at, status) VALUES (?, ?, ?, 'claimed')",
            [coId, uId, now]
        );

        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, "คุณเก็บคูปองนี้แล้ว");
        throw err;
    } finally {
        conn.release();
    }
}

export async function listUserCoupons(uId: number): Promise<UserCouponDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & UserCouponDTO)[]>(
        `
        SELECT
            uc.uc_id,
            uc.co_id,
            uc.u_id,
            uc.or_id,
            uc.claimed_at,
            uc.used_at,
            uc.status,
            c.co_code,
            c.discount_type,
            c.discount_value,
            c.max_discount_amount,
            c.co_datetime_start,
            c.co_datetime_end,
            c.min_order_amount,
            c.active,
            c.st_id
        FROM UserCoupons uc
        INNER JOIN Coupon c ON c.co_id = uc.co_id
        WHERE uc.u_id = ?
        ORDER BY uc.claimed_at DESC
        `,
        [uId]
    );

    return rows;
}

export async function validateCoupon(input: ValidateCouponInput): Promise<ValidateCouponResult> {
    const conn = await pool.getConnection();

    try {
        return await validateCouponWithConnection(conn, input);
    } finally {
        conn.release();
    }
}

export async function validateCouponForCheckout(
    conn: PoolConnection,
    input: ValidateCouponInput
): Promise<ValidateCouponResult> {
    // ใช้ connection เดียวกับ order transaction และ lock coupon row ระหว่าง checkout
    return validateCouponWithConnection(conn, input, true);
}

export async function redeemCoupon(input: RedeemCouponInput): Promise<void> {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const [couponRows] = await conn.query<RowDataPacket[]>(
            "SELECT co_id, used_count, usage_limit_total FROM Coupon WHERE co_id = ? FOR UPDATE",
            [input.co_id]
        );

        const coupon = couponRows[0];
        if (!coupon) throw new ApiError(404, "ไม่พบคูปอง");
        const usageLimitTotal = coupon.usage_limit_total === null ? null : Number(coupon.usage_limit_total);

        // เช็ก limit ซ้ำตอน redeem เพราะ validate กับ redeem อาจเกิดคนละช่วงเวลา
        if (usageLimitTotal !== null && Number(coupon.used_count) >= usageLimitTotal) {
            throw new ApiError(400, "คูปองถูกใช้ครบจำนวนแล้ว");
        }

        await conn.query(
            `
            INSERT INTO CouponRedemptions
                (co_id, u_id, or_id, co_code_snapshot, subtotal_amount, discount_amount, used_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
            [
                input.co_id,
                input.u_id,
                input.or_id,
                input.co_code_snapshot,
                input.subtotal_amount,
                input.discount_amount,
                new Date(),
            ]
        );

        await conn.query(
            "UPDATE Coupon SET used_count = used_count + 1, update_at = ? WHERE co_id = ?",
            [new Date(), input.co_id]
        );

        await conn.query(
            `
            UPDATE UserCoupons
            SET status = 'used',
                used_at = ?,
                or_id = ?
            WHERE co_id = ?
              AND u_id = ?
              AND status = 'claimed'
            `,
            [new Date(), input.or_id, input.co_id, input.u_id]
        );

        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, "คูปองนี้ถูกใช้กับคำสั่งซื้อนี้แล้ว");
        throw err;
    } finally {
        conn.release();
    }
}

export async function redeemCouponForCheckout(
    conn: PoolConnection,
    input: RedeemCouponInput
): Promise<void> {
    const [couponRows] = await conn.query<RowDataPacket[]>(
        "SELECT co_id, used_count, usage_limit_total FROM Coupon WHERE co_id = ? FOR UPDATE",
        [input.co_id]
    );

    const coupon = couponRows[0];
    if (!coupon) throw new ApiError(404, "ไม่พบคูปอง");
    const usageLimitTotal = coupon.usage_limit_total === null ? null : Number(coupon.usage_limit_total);

    // ฟังก์ชันนี้ไม่ begin/commit เอง เพราะถูกเรียกอยู่ใน order transaction
    if (usageLimitTotal !== null && Number(coupon.used_count) >= usageLimitTotal) {
        throw new ApiError(400, "คูปองถูกใช้ครบจำนวนแล้ว");
    }

    await conn.query(
        `
        INSERT INTO CouponRedemptions
            (co_id, u_id, or_id, co_code_snapshot, subtotal_amount, discount_amount, used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
            input.co_id,
            input.u_id,
            input.or_id,
            input.co_code_snapshot,
            input.subtotal_amount,
            input.discount_amount,
            new Date(),
        ]
    );

    await conn.query(
        "UPDATE Coupon SET used_count = used_count + 1, update_at = ? WHERE co_id = ?",
        [new Date(), input.co_id]
    );

    await conn.query(
        `
        UPDATE UserCoupons
        SET status = 'used',
            used_at = ?,
            or_id = ?
        WHERE co_id = ?
          AND u_id = ?
          AND status = 'claimed'
        `,
        [new Date(), input.or_id, input.co_id, input.u_id]
    );
}
