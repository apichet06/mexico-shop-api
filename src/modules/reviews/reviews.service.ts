import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"
import { pool } from "../../db/pool.js"
import { ApiError } from "../../shared/errors/ApiError.js"
import { fileUploadImage } from "../../shared/middlewares/fileUploadImage.js"
import { setOrdersStatus } from "../orders/order-status.service.js"
import type { CreateReviewInput, ReviewDTO, ReviewSummary } from "./reviews.type.js"

// ดึงรีวิวทั้งหมดของ pv_id พร้อม pagination
export async function getReviews(
    pv_id: number,
    page: number,
    limit: number
): Promise<{ reviews: ReviewDTO[]; summary: ReviewSummary; total: number }> {
    const offset = (page - 1) * limit

    // ดึงรีวิวพร้อม username, avatar และรวมรูปภาพด้วย GROUP_CONCAT
    const [rows] = await pool.query<(RowDataPacket & {
        ed_id: number; pv_id: number; oi_id: number; u_id: number
        u_username: string; u_avatar: string | null
        massages: string; delivery_score: number; product_score: number
        create_at: string; images: string | null
    })[]>(
        `SELECT
            ed.ed_id, ed.pv_id, ed.oi_id, ed.u_id,
            u.u_username, u.u_avatar,
            ed.massages, ed.delivery_score, ed.product_score, ed.create_at,
            GROUP_CONCAT(edi.url_image ORDER BY edi.edi_id SEPARATOR ',') AS images
        FROM Estimate_delivery ed
        JOIN Users u ON u.u_id = ed.u_id
        LEFT JOIN Estimate_delivery_image edi ON edi.ed_id = ed.ed_id
        WHERE ed.pv_id = ?
        GROUP BY ed.ed_id
        ORDER BY ed.create_at DESC
        LIMIT ? OFFSET ?`,
        [pv_id, limit, offset]
    )

    // นับยอดรวมและคำนวณคะแนนเฉลี่ย
    const [summaryRows] = await pool.query<(RowDataPacket & ReviewSummary)[]>(
        `SELECT
            COUNT(*) AS total,
            ROUND(AVG(product_score), 1) AS avg_product_score,
            ROUND(AVG(delivery_score), 1) AS avg_delivery_score
        FROM Estimate_delivery
        WHERE pv_id = ?`,
        [pv_id]
    )

    const summary = summaryRows[0] ?? { total: 0, avg_product_score: 0, avg_delivery_score: 0 }

    const reviews: ReviewDTO[] = rows.map(r => ({
        ...r,
        // แปลง GROUP_CONCAT string เป็น array (กรองค่าว่างออก)
        images: r.images ? r.images.split(",").filter(Boolean) : [],
    }))

    return { reviews, summary, total: summary.total }
}

// สร้างรีวิวใหม่ (ต้องซื้อสินค้านั้นจริงๆ)
export async function createReview(input: CreateReviewInput): Promise<void> {
    const conn = await pool.getConnection()
    try {
        await conn.beginTransaction()

        // ตรวจว่า oi_id นั้นเป็นของ user นี้และมี pv_id ตรงกัน
        // เช็ค 3 ทางเพราะ delivered อาจมาจาก: legacy status, shipment_status จาก SHIPPOP, หรือ s_code ใหม่
        // lock order item เพื่อให้ request รีวิว oi_id เดียวกันทำงานทีละรายการ
        const [orderCheck] = await conn.query<RowDataPacket[]>(
            `SELECT oi.oi_id
         FROM Order_items oi
         JOIN Orders o ON o.or_id = oi.or_id
         LEFT JOIN Status os ON os.s_id = o.s_id
         WHERE oi.oi_id = ? AND oi.pv_id = ? AND o.u_id = ?
           AND (
               o.status IN ('delivered', 'reviewed')
               OR o.shipment_status = 'delivered'
               OR os.s_code IN ('DELIVERED', 'RECEIVED', 'AUTO_RECEIVED', 'REVIEWED')
           )
         LIMIT 1
         FOR UPDATE`,
            [input.oi_id, input.pv_id, input.u_id]
        )

        if (!orderCheck[0]) throw new ApiError(403, "ต้องรับสินค้าเรียบร้อยก่อนจึงจะรีวิวได้")

        // ป้องกันรีวิวซ้ำในรายการสั่งซื้อเดิม
        const [dupCheck] = await conn.query<RowDataPacket[]>(
            "SELECT ed_id FROM Estimate_delivery WHERE oi_id = ? LIMIT 1",
            [input.oi_id]
        )

        if (dupCheck[0]) throw new ApiError(409, "คุณรีวิวรายการนี้ไปแล้ว")

        const [result] = await conn.query<ResultSetHeader>(
            "INSERT INTO Estimate_delivery SET ?",
            [{
                u_id: input.u_id,
                pv_id: input.pv_id,
                oi_id: input.oi_id,
                massages: input.massages,
                delivery_score: input.delivery_score,
                product_score: input.product_score,
                create_at: new Date(),
            }]
        )

        const ed_id = result.insertId

        // อัปโหลดรูปและบันทึก path ลง Estimate_delivery_image
        for (let i = 0; i < input.imageFiles.length; i++) {
            const file = input.imageFiles[i]!
            const url = await fileUploadImage(file, `review_${ed_id}_${i}`, "reviews")
            await conn.query("INSERT INTO Estimate_delivery_image SET ?", [{ ed_id, url_image: url }])
        }

        await conn.commit()

        // หลัง commit — เช็คว่า order นี้รีวิวครบทุก item แล้วหรือยัง
        // ถ้าครบให้เปลี่ยนสถานะ order เป็น REVIEWED
        const [orRows] = await conn.query<(RowDataPacket & { or_id: number })[]>(
            "SELECT or_id FROM Order_items WHERE oi_id = ? LIMIT 1",
            [input.oi_id]
        )
        const or_id = orRows[0]?.or_id
        if (or_id) {
            const [reviewProgress] = await conn.query<(RowDataPacket & {
                total_items: number;
                reviewed_items: number;
            })[]>(
                `SELECT COUNT(oi.oi_id) AS total_items,
                        COUNT(ed.ed_id)  AS reviewed_items
                 FROM Order_items oi
                 LEFT JOIN Estimate_delivery ed ON ed.oi_id = oi.oi_id
                 WHERE oi.or_id = ?`,
                [or_id]
            )
            const progress = reviewProgress[0]
            if (progress && progress.total_items > 0 && progress.total_items === progress.reviewed_items) {
                // ทุก item รีวิวครบ — update order เป็น REVIEWED
                await conn.beginTransaction()
                try {
                    await setOrdersStatus(conn, [or_id], "REVIEWED")
                    await conn.commit()
                } catch {
                    await conn.rollback()
                    // ไม่ throw — review บันทึกสำเร็จแล้ว แค่ status อัพไม่ได้
                }
            }
        }
    } catch (err) {
        await conn.rollback()
        throw err
    } finally {
        conn.release()
    }
}

// ตรวจว่า user นี้มีสิทธิ์รีวิว pv_id นี้มั้ย
// คืน list oi_id ที่ยังไม่เคยรีวิว
export async function getReviewableItems(u_id: number, pv_id: number) {
    const [rows] = await pool.query<(RowDataPacket & { oi_id: number })[]>(
        `SELECT oi.oi_id
         FROM Order_items oi
         JOIN Orders o ON o.or_id = oi.or_id
         WHERE oi.pv_id = ? AND o.u_id = ? AND o.status = 'delivered'
           AND oi.oi_id NOT IN (
               SELECT oi_id FROM Estimate_delivery WHERE oi_id IS NOT NULL
           )
         LIMIT 5`,
        [pv_id, u_id]
    )

    return rows.map(r => r.oi_id)
}

export type FeaturedProductReview = {
    ed_id: number
    p_id: number
    product_name: string
    u_username: string
    massages: string
    product_score: number
    create_at: string
}

export async function getFeaturedProductReviews(
    ctlId: number,
    language: string,
    limit: number
): Promise<FeaturedProductReview[]> {
    const [rows] = await pool.query<(RowDataPacket & FeaturedProductReview)[]>(
        `
        SELECT
            ed.ed_id,
            p.p_id,
            pl.p_name AS product_name,
            u.u_username,
            ed.massages,
            ed.product_score,
            ed.create_at
        FROM Estimate_delivery ed
        INNER JOIN Users u
            ON u.u_id = ed.u_id
        INNER JOIN ProductVariants pv
            ON pv.pv_id = ed.pv_id
        INNER JOIN Products p
            ON p.p_id = pv.p_id
        INNER JOIN ProductLangs pl
            ON pl.p_id = p.p_id
           AND pl.lg_code = ?
        WHERE p.ctl_id = ?
          AND p.p_isActive = 1
          AND p.p_isAccept = 1
          AND ed.product_score >= 4
          AND TRIM(COALESCE(ed.massages, '')) <> ''
         ORDER BY RAND()
        LIMIT ?
        `,
        [language, ctlId, limit]
    )

    return rows.map(row => ({
        ed_id: Number(row.ed_id),
        p_id: Number(row.p_id),
        product_name: String(row.product_name),
        u_username: String(row.u_username),
        massages: String(row.massages),
        product_score: Number(row.product_score),
        create_at: String(row.create_at),
    }))
}