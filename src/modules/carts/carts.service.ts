import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import type { AddCartItemInput, CartDTO, CartItemDetailDTO, CartItemDTO, UpdateCartItemInput, UpdateCartItemQtyInput } from "./type.js";

export async function addCartItem(input: AddCartItemInput): Promise<CartItemDTO> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [pvRows] = await conn.query<(RowDataPacket & { pv_price: number; discount: number })[]>(
            "SELECT pv_price, COALESCE(discount, 0) AS discount FROM ProductVariants WHERE pv_id = ? LIMIT 1",
            [input.pv_id]
        );

        const variant = pvRows[0];
        if (!variant) throw new ApiError(404, "ไม่พบสินค้าที่ระบุ");

        const unitPrice = Number(variant.pv_price);
        const discountAmount = Math.round(unitPrice * (Number(variant.discount) / 100) * 100) / 100;
        const effectivePrice = unitPrice - discountAmount;

        const [cartRows] = await conn.query<(RowDataPacket & { cart_id: number })[]>(
            "SELECT cart_id FROM Carts WHERE u_id = ? AND status = 'active' ORDER BY cart_id DESC LIMIT 1",
            [input.u_id]
        );

        let cartId: number;
        if (cartRows[0]) {
            cartId = cartRows[0].cart_id;
        } else {
            const [cartRes] = await conn.query<ResultSetHeader>(
                "INSERT INTO Carts SET ?",
                [{ u_id: input.u_id, status: "active", created_at: new Date(), updated_at: new Date() }]
            );
            cartId = cartRes.insertId;
        }

        const [existingRows] = await conn.query<(RowDataPacket & { ci_id: number; qty: number })[]>(
            "SELECT ci_id, qty FROM Cart_items WHERE cart_id = ? AND pv_id = ? LIMIT 1",
            [cartId, input.pv_id]
        );

        let ciId: number;

        if (existingRows[0]) {
            const newQty = existingRows[0].qty + input.qty;
            const newLineTotal = Math.round(effectivePrice * newQty * 100) / 100;
            ciId = existingRows[0].ci_id;

            await conn.query(
                "UPDATE Cart_items SET qty = ?, line_total = ?, updated_at = ? WHERE ci_id = ?",
                [newQty, newLineTotal, new Date(), ciId]
            );
        } else {
            const lineTotal = Math.round(effectivePrice * input.qty * 100) / 100;
            const [itemRes] = await conn.query<ResultSetHeader>(
                "INSERT INTO Cart_items SET ?",
                [{
                    cart_id: cartId,
                    pv_id: input.pv_id,
                    qty: input.qty,
                    unit_price: unitPrice,
                    discount_amount: discountAmount,
                    line_total: lineTotal,
                    is_selected: 0,
                    created_at: new Date(),
                    updated_at: new Date(),
                }]
            );
            ciId = itemRes.insertId;
        }

        await conn.commit();

        const [rows] = await conn.query<(RowDataPacket & CartItemDTO)[]>(
            "SELECT ci_id, cart_id, pv_id, qty, unit_price, discount_amount, line_total, created_at, updated_at FROM Cart_items WHERE ci_id = ?",
            [ciId]
        );

        if (!rows[0]) throw new ApiError(500, "เกิดข้อผิดพลาดในการบันทึกข้อมูล");
        return rows[0];
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function getCart(u_id: number, lg_code = "th"): Promise<CartDTO> {
    const conn = await pool.getConnection();
    try {
        const [cartRows] = await conn.query<(RowDataPacket & { cart_id: number; status: string })[]>(
            "SELECT cart_id, status FROM Carts WHERE u_id = ? AND status = 'active' ORDER BY cart_id DESC LIMIT 1",
            [u_id]
        );

        if (!cartRows[0]) {
            return { cart_id: 0, status: "active", items: [], total_amount: 0, item_count: 0 };
        }

        const cartId = cartRows[0].cart_id;

        const [itemRows] = await conn.query<(RowDataPacket & CartItemDetailDTO)[]>(
            `SELECT
                ci.ci_id,
                ci.cart_id,
                ci.pv_id,
                ci.qty,
                ci.unit_price,
                ci.discount_amount,
                ci.line_total,
                ci.is_selected,
                pv.pv_sku,
                COALESCE(pv.image_url, ip.ip_image_url) AS image_url,
                GROUP_CONCAT(
                    DISTINCT CONCAT(ot.otype_name, ': ', poi.poi_value)
                    ORDER BY po.otype_id, poi.poi_id
                    SEPARATOR ' | '
                ) AS variant_label,
                p.p_id,
                p.ctl_id,
                p.st_id,
                s.st_company_name,
                pl.p_name
            FROM Cart_items ci
            INNER JOIN ProductVariants pv ON pv.pv_id = ci.pv_id
            INNER JOIN Products p ON p.p_id = pv.p_id
            INNER JOIN Store s ON s.st_id = p.st_id
            LEFT JOIN ProductLangs pl ON pl.p_id = p.p_id AND pl.lg_code = ?
            LEFT JOIN ImageProduct ip ON ip.ip_id = (
                SELECT ip_id FROM ImageProduct WHERE p_id = p.p_id ORDER BY ip_id ASC LIMIT 1
            )
            LEFT JOIN VariantOptionItems voi ON voi.pv_id = pv.pv_id
            LEFT JOIN ProductOptionItems poi ON poi.poi_id = voi.poi_id
            LEFT JOIN ProductOptions po ON po.potn_id = poi.potn_id
            LEFT JOIN OptionTypes ot ON ot.otype_id = po.otype_id
            WHERE ci.cart_id = ?
            GROUP BY
                ci.ci_id, ci.cart_id, ci.pv_id, ci.qty,
                ci.unit_price, ci.discount_amount, ci.line_total, ci.is_selected,
                pv.pv_sku, pv.image_url, ip.ip_image_url, p.p_id, p.ctl_id, p.st_id, s.st_company_name, pl.p_name
            ORDER BY ci.ci_id ASC`,
            [lg_code, cartId]
        );

        const totalAmount = itemRows.reduce((sum, r) => sum + Number(r.line_total), 0);
        const totalAmount2dp = Math.round(totalAmount * 100) / 100;

        return {
            cart_id: cartId,
            status: cartRows[0].status,
            items: itemRows,
            total_amount: totalAmount2dp,
            item_count: itemRows.length,
        };
    } finally {
        conn.release();
    }
}

export async function updateCartItem(input: UpdateCartItemInput): Promise<CartItemDTO> {
    const conn = await pool.getConnection();
    try {
        // ตรวจว่า ci_id นี้เป็นของ user คนนี้จริง
        const [rows] = await conn.query<(RowDataPacket & { ci_id: number })[]>(
            `SELECT ci.ci_id FROM Cart_items ci
             INNER JOIN Carts c ON c.cart_id = ci.cart_id
             WHERE ci.ci_id = ? AND c.u_id = ? AND c.status = 'active' LIMIT 1`,
            [input.ci_id, input.u_id]
        );

        if (!rows[0]) throw new ApiError(404, "ไม่พบรายการสินค้าในตะกร้า");

        await conn.query(
            "UPDATE Cart_items SET is_selected = ?, updated_at = ? WHERE ci_id = ?",
            [input.is_selected, new Date(), input.ci_id]
        );

        const [updated] = await conn.query<(RowDataPacket & CartItemDTO)[]>(
            "SELECT ci_id, cart_id, pv_id, qty, unit_price, discount_amount, line_total, created_at, updated_at FROM Cart_items WHERE ci_id = ?",
            [input.ci_id]
        );

        if (!updated[0]) throw new ApiError(500, "เกิดข้อผิดพลาดในการอัปเดตข้อมูล");
        return updated[0];
    } finally {
        conn.release();
    }
}

export async function updateCartItemQty(input: UpdateCartItemQtyInput): Promise<CartItemDTO> {
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.query<(RowDataPacket & { ci_id: number; unit_price: number; discount_amount: number })[]>(
            `SELECT ci.ci_id, ci.unit_price, ci.discount_amount
             FROM Cart_items ci
             INNER JOIN Carts c ON c.cart_id = ci.cart_id
             WHERE ci.ci_id = ? AND c.u_id = ? AND c.status = 'active' LIMIT 1`,
            [input.ci_id, input.u_id]
        );

        if (!rows[0]) throw new ApiError(404, "ไม่พบรายการสินค้าในตะกร้า");

        const { unit_price, discount_amount } = rows[0];
        const effectivePrice = Number(unit_price) - Number(discount_amount);
        const newLineTotal = Math.round(effectivePrice * input.qty * 100) / 100;

        await conn.query(
            "UPDATE Cart_items SET qty = ?, line_total = ?, updated_at = ? WHERE ci_id = ?",
            [input.qty, newLineTotal, new Date(), input.ci_id]
        );

        const [updated] = await conn.query<(RowDataPacket & CartItemDTO)[]>(
            "SELECT ci_id, cart_id, pv_id, qty, unit_price, discount_amount, line_total, created_at, updated_at FROM Cart_items WHERE ci_id = ?",
            [input.ci_id]
        );

        if (!updated[0]) throw new ApiError(500, "เกิดข้อผิดพลาดในการอัปเดตข้อมูล");
        return updated[0];
    } finally {
        conn.release();
    }
}


export async function deleteCartItem(ci_id: number, u_id: number): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [rows] = await conn.query<(RowDataPacket & { ci_id: number; cart_id: number })[]>(
            `SELECT ci.ci_id, ci.cart_id FROM Cart_items ci
             INNER JOIN Carts c ON c.cart_id = ci.cart_id
             WHERE ci.ci_id = ? AND c.u_id = ? AND c.status = 'active' LIMIT 1`,
            [ci_id, u_id]
        );

        if (!rows[0]) throw new ApiError(404, "ไม่พบรายการสินค้าในตะกร้า");

        const cartId = rows[0].cart_id;

        await conn.query("DELETE FROM Cart_items WHERE ci_id = ?", [ci_id]);

        const [remaining] = await conn.query<(RowDataPacket & { cnt: number })[]>(
            "SELECT COUNT(*) AS cnt FROM Cart_items WHERE cart_id = ?",
            [cartId]
        );

        if (remaining[0]!.cnt === 0) {
            await conn.query("DELETE FROM Carts WHERE cart_id = ?", [cartId]);
        }

        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}
