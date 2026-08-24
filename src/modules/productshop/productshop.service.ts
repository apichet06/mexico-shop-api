import type { RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import type { InventoryByVariantDTO, InventoryStoreDTO, LandignPageNamgeDTO, ProductImageDTO, ProductOptionGroupDTO, ProductShopByIdResponse, ProductShopDetailDTO, ProductShopDTO, ProductTagDTO, ProductVariantDTO } from "./productshop.type.js";

export type GetProductShopParams = {
    lg_code: string
    keyword?: string
    sort?: string
    page?: number
    category?: string
    limit?: number
    ctl_id?: number  // filter ตาม catalog (arcana=1, deadstock=2)
    random?: boolean
    in_stock_only?: boolean
}

/**
 * Fisher-Yates shuffle — สลับตำแหน่ง array แบบ random
 * ทำงาน O(n) ไม่ใช้ ORDER BY RAND() ที่ช้าใน SQL
 */
function shuffleArray<T>(arr: T[]): T[] {
    const copy = [...arr]
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        // ใช้ temp variable + as T เพราะ TypeScript ถือว่า index access คืน T | undefined
        // แต่เรารู้ว่า i และ j อยู่ใน bounds แน่นอน จึง cast ได้ปลอดภัย
        const temp = copy[i] as T
        copy[i] = copy[j] as T
        copy[j] = temp
    }
    return copy
}

function normalizeSort(sort?: string) {
    switch (sort) {
        case "new":
        case "popular":
        case "featured":
        case "price-low":
        case "price-high":
        case "all":
            return sort
        default:
            return "all"
    }
}

type ProductShopResponse = {
    items: ProductShopDTO[]
    pagination: {
        total: number
        page: number
        limit: number
        totalPages: number
    }
}


export async function getProductShop({
    lg_code,
    keyword = "",
    sort = "all",
    page = 1,
    category = "",
    limit = 12,
    ctl_id,
    random = false,
    in_stock_only = false,
}: GetProductShopParams): Promise<ProductShopResponse> {
    const conn = await pool.getConnection()

    try {
        const safePage = Number.isFinite(page) && page > 0 ? page : 1
        const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 12
        const safeSort = normalizeSort(sort)
        const trimmedKeyword = keyword.trim()
        const safeCategory = category.trim()

        const whereConditions: string[] = [`b.lg_code = ?`]
        const queryParams: Array<string | number> = [lg_code]

        if (trimmedKeyword) {
            whereConditions.push(`
                (
                    b.p_name LIKE ?
                    OR b.p_title LIKE ?
                    OR f.b_name LIKE ?
                    OR e.ctl_name LIKE ?
                )
            `)

            const keywordLike = `%${trimmedKeyword}%`
            queryParams.push(keywordLike, keywordLike, keywordLike, keywordLike)
        }

        if (safeSort === "new") {
            whereConditions.push(`
                EXISTS (
                    SELECT 1
                    FROM ProductTagMaps ptm
                    WHERE ptm.p_id = a.p_id
                      AND ptm.ptag_id = 2
                )
            `)
        }

        if (safeSort === "popular") {
            whereConditions.push(`
                EXISTS (
                    SELECT 1
                    FROM ProductTagMaps ptm
                    WHERE ptm.p_id = a.p_id
                      AND ptm.ptag_id = 1
                )
            `)
        }

        if (safeSort === "featured") {
            whereConditions.push(`
                EXISTS (
                    SELECT 1
                    FROM ProductTagMaps ptm
                    WHERE ptm.p_id = a.p_id
                      AND ptm.ptag_id = 3
                )
            `)
        }

        if (safeCategory) {
            whereConditions.push(`a.c_id = ?`)
            queryParams.push(Number(safeCategory))
        }

        // filter ตาม catalog (arcana / deadstock) ที่ฝั่ง DB เลย ไม่ต้อง filter ซ้ำ client
        if (ctl_id) {
            whereConditions.push(`a.ctl_id = ?`)
            queryParams.push(ctl_id)
        }

        whereConditions.push(`a.p_isActive = 1`)
        whereConditions.push(`a.p_isAccept = 1`)

        if (in_stock_only) {
            whereConditions.push(`
                EXISTS (
                    SELECT 1
                    FROM Inventorys stock_inv
                    INNER JOIN ProductVariants stock_pv
                        ON stock_pv.pv_id = stock_inv.pv_id
                    WHERE stock_pv.p_id = a.p_id
                    GROUP BY stock_pv.p_id
                    HAVING
                        COALESCE(SUM(stock_inv.on_hand), 0)
                        - COALESCE(SUM(stock_inv.reserved_qty), 0) > 0
                )
            `)
        }

        const whereSql = whereConditions.length > 0
            ? `WHERE ${whereConditions.join(" AND ")}`
            : ""

        let orderBySql = `ORDER BY a.p_id DESC`

        if (safeSort === "price-low") {
            orderBySql = `ORDER BY min_price ASC, a.p_id DESC`
        } else if (safeSort === "price-high") {
            orderBySql = `ORDER BY max_price DESC, a.p_id DESC`
        }

        const countSql = `
            SELECT COUNT(*) AS total
            FROM (
                SELECT a.p_id
                FROM Products a
                INNER JOIN ProductLangs b
                    ON a.p_id = b.p_id
                INNER JOIN ProductVariants d
                    ON d.p_id = a.p_id
                INNER JOIN Catalog e
                    ON e.ctl_id = a.ctl_id
                INNER JOIN Brands f
                    ON f.b_id = a.b_id
                ${whereSql}
                GROUP BY a.p_id
            ) counted
        `

        const [countRows] = await conn.query<(RowDataPacket & { total: number })[]>(
            countSql,
            queryParams
        )

        const total = countRows[0]?.total ?? 0
        const totalPages = Math.max(1, Math.ceil(total / safeLimit))
        const currentPage = Math.min(safePage, totalPages)
        const offset = (currentPage - 1) * safeLimit

        const listSql = `
            SELECT 
                a.p_id,
                a.p_isActive,
                b.p_name AS name,
                b.p_title AS title,
                c.ip_image_url,
                MIN(d.pv_price) AS min_price,
                MAX(d.pv_price) AS max_price,
                MAX(COALESCE(d.discount, 0)) AS discount,
                a.c_id,
                e.ctl_id,
                e.ctl_name,
                f.b_id,
                f.b_name,
                g.st_id,
                g.st_company_name, 
                CASE
                    WHEN MIN(d.pv_price) = MAX(d.pv_price) THEN 0
                    ELSE 1
                END AS has_price_range,
                (
                    SELECT ROUND(AVG(ed.product_score), 1)
                    FROM Estimate_delivery ed
                    INNER JOIN ProductVariants pv ON pv.pv_id = ed.pv_id
                    WHERE pv.p_id = a.p_id
                ) AS avg_rating,
                (
                    SELECT COUNT(*)
                    FROM Estimate_delivery ed
                    INNER JOIN ProductVariants pv ON pv.pv_id = ed.pv_id
                    WHERE pv.p_id = a.p_id
                ) AS review_count,
                IF(
                    COALESCE((
                        SELECT SUM(inv.on_hand) - SUM(inv.reserved_qty)
                        FROM Inventorys inv
                        INNER JOIN ProductVariants pv ON pv.pv_id = inv.pv_id
                        WHERE pv.p_id = a.p_id
                    ), 0) <= 0,
                    1,
                    0
                ) AS is_out_of_stock
            FROM Products a
            INNER JOIN ProductLangs b 
                ON a.p_id = b.p_id
            LEFT JOIN (
                SELECT p_id, MIN(ip_id) AS ip_id
                FROM ImageProduct
                GROUP BY p_id
            ) first_img ON first_img.p_id = a.p_id
            LEFT JOIN ImageProduct c ON c.ip_id = first_img.ip_id
            INNER JOIN ProductVariants d 
                ON d.p_id = a.p_id
            INNER JOIN Catalog e 
                ON e.ctl_id = a.ctl_id
            INNER JOIN Brands f 
                ON f.b_id = a.b_id
            INNER JOIN Store g 
                ON g.st_id = a.st_id
            
            ${whereSql}
            GROUP BY 
                a.p_id,
                a.p_isActive,
                b.p_name,
                b.p_title,
                c.ip_image_url,
                a.c_id,
                e.ctl_id,
                e.ctl_name,
                f.b_id,
                f.b_name
            ${orderBySql}
            LIMIT ?
            OFFSET ?
        `

        const [rows] = await conn.query<(RowDataPacket & ProductShopDTO)[]>(
            listSql,
            [...queryParams, safeLimit, offset]
        )

        if (rows.length === 0) {
            return {
                items: [],
                pagination: {
                    total,
                    page: currentPage,
                    limit: safeLimit,
                    totalPages,
                },
            }
        }

        const productIds = rows.map((row) => row.p_id)

        const [tagRows] = await conn.query<RowDataPacket[]>(
            `
            SELECT 
                e.p_id,
                e.ptag_id,
                f.ptag_name
            FROM ProductTagMaps e
            INNER JOIN ProductTagLangs f
                ON f.ptag_id = e.ptag_id
            WHERE f.lg_code = ?
              AND e.p_id IN (?)
            `,
            [lg_code, productIds]
        )

        const tagMap = new Map<number, { ptag_id: number; ptag_name: string }[]>()

        for (const tag of tagRows) {
            if (!tagMap.has(tag.p_id)) {
                tagMap.set(tag.p_id, [])
            }

            tagMap.get(tag.p_id)!.push({
                ptag_id: Number(tag.ptag_id),
                ptag_name: String(tag.ptag_name),
            })
        }

        const mappedItems: ProductShopDTO[] = rows.map((row) => ({
            ...row,
            min_price: Number(row.min_price ?? 0),
            max_price: Number(row.max_price ?? 0),
            discount: Number(row.discount ?? 0),
            has_price_range: Number(row.has_price_range) === 1 ? 1 : 0,
            tags: tagMap.get(row.p_id) ?? [],
        }))

        // shuffle เฉพาะ tag-based sort ที่ขอ random เช่นหน้าแรก
        // หน้ารวมสินค้าต้องเรียงนิ่งเพื่อให้ pagination ไม่ซ้ำ/ไม่ขาดตอน
        // sort ตามราคา (price-low/price-high) ไม่ shuffle เพราะ ordering มีความหมาย
        const TAG_SORTS = ["new", "popular", "featured"] as const
        const items = random && TAG_SORTS.includes(safeSort as typeof TAG_SORTS[number])
            ? shuffleArray(mappedItems)
            : mappedItems

        return {
            items,
            pagination: {
                total,
                page: currentPage,
                limit: safeLimit,
                totalPages,
            },
        }
    } finally {
        conn.release()
    }
}



export async function getProductShopById(
    p_id: number,
    lg_code: string
): Promise<ProductShopByIdResponse | null> {
    const conn = await pool.getConnection()

    try {
        const [rows] = await conn.query<(RowDataPacket & ProductShopDetailDTO)[]>(
            `
            SELECT
                a.p_id,
                a.p_isActive,
                a.st_id,
                b.p_name AS name,
                b.p_title AS title,
                a.c_id,
                e.ctl_id,
                e.ctl_name,
                f.b_id,
                f.b_name,
                b.p_description,
                g.ps_name,
                i.cl_name,
                j.st_company_name,
                j.st_image,
                MIN(d.pv_price) AS min_price,
                MAX(d.pv_price) AS max_price,
                MAX(COALESCE(d.discount, 0)) AS discount,
                CASE
                    WHEN MIN(d.pv_price) = MAX(d.pv_price) THEN 0
                    ELSE 1
                END AS has_price_range
            FROM Products a
            INNER JOIN ProductLangs b
                ON a.p_id = b.p_id
            INNER JOIN ProductVariants d
                ON d.p_id = a.p_id
            INNER JOIN Catalog e
                ON e.ctl_id = a.ctl_id
            INNER JOIN Brands f
                ON f.b_id = a.b_id
            INNER JOIN ProductStatus g
                ON g.ps_id = a.ps_id
            INNER JOIN Categorys h
                ON h.c_id = a.c_id
            INNER JOIN CategoryLangs i
                ON i.c_id = h.c_id
            INNER JOIN Store j
                ON j.st_id = a.st_id
            WHERE a.p_id = ?
              AND b.lg_code = ?
              AND i.lg_code = ?
            GROUP BY
                a.p_id,
                a.p_isActive,
                a.st_id,
                b.p_name,
                b.p_title,
                a.c_id,
                e.ctl_id,
                e.ctl_name,
                f.b_id,
                f.b_name,
                b.p_description,
                g.ps_name,
                i.cl_name,
                j.st_company_name,
                j.st_image
            `,
            [p_id, lg_code, lg_code]
        )

        if (!rows.length) {
            return null
        }

        const [imageRows] = await conn.query<(RowDataPacket & ProductImageDTO)[]>(
            `
            SELECT
                ip_id,
                ip_image_url,
                is_primary
            FROM ImageProduct
            WHERE p_id = ?
            ORDER BY
                CASE WHEN is_primary = 1 THEN 0 ELSE 1 END,
                ip_id ASC
            `,
            [p_id]
        )

        //  รวม stock ทุกคลังให้เหลือ 1 แถวต่อ 1 variant
        const [variantRows] = await conn.query<(RowDataPacket & ProductVariantDTO)[]>(
            `
            SELECT
                pv.pv_id,
                pv.pv_sku,
                pv.pv_cost,
                pv.pv_price,
                COALESCE(pv.discount, 0) AS discount,
                pv.is_default,
                pv.image_url,
                pv.weight_g,
                pv.length_cm,
                pv.width_cm,
                pv.height_cm,
                pv.unit_id,
                ul.ul_name AS unit_name,
                COALESCE(SUM(inv.on_hand), 0) AS total_on_hand,
                COALESCE(SUM(inv.reserved_qty), 0) AS total_reserved_qty,
                COALESCE(SUM(inv.on_hand), 0) - COALESCE(SUM(inv.reserved_qty), 0) AS available_qty,
                GROUP_CONCAT(
                    DISTINCT CONCAT(ot.otype_name, ': ', poi.poi_value)
                    ORDER BY po.otype_id, poi.poi_id
                    SEPARATOR ' | '
                ) AS variant_label
            FROM ProductVariants pv
            LEFT JOIN VariantOptionItems voi
                ON voi.pv_id = pv.pv_id
            LEFT JOIN ProductOptionItems poi
                ON poi.poi_id = voi.poi_id
            LEFT JOIN ProductOptions po
                ON po.potn_id = poi.potn_id
            LEFT JOIN OptionTypes ot
                ON ot.otype_id = po.otype_id
            LEFT JOIN Inventorys inv
                ON inv.pv_id = pv.pv_id
            LEFT JOIN UnitLangs ul
                ON ul.u_id = pv.unit_id
               AND ul.lg_code = ?
            WHERE pv.p_id = ?
            GROUP BY
                pv.pv_id,
                pv.pv_sku,
                pv.pv_cost,
                pv.pv_price,
                pv.discount,
                pv.is_default,
                pv.image_url,
                pv.weight_g,
                pv.length_cm,
                pv.width_cm,
                pv.height_cm,
                pv.unit_id,
                ul.ul_name
            ORDER BY
                pv.is_default DESC,
                available_qty DESC,
                pv.pv_id ASC
            `,
            [lg_code, p_id]
        )

        const [optionRows] = await conn.query<
            (RowDataPacket & {
                potn_id: number
                otype_id: number
                otype_code: string
                otype_name: string
                poi_id: number
                poi_value: string
            })[]
        >(
            `
            SELECT
                po.potn_id,
                po.otype_id,
                ot.otype_code,
                ot.otype_name,
                poi.poi_id,
                poi.poi_value
            FROM ProductOptions po
            INNER JOIN OptionTypes ot
                ON ot.otype_id = po.otype_id
            INNER JOIN ProductOptionItems poi
                ON poi.potn_id = po.potn_id
            WHERE po.p_id = ?
            ORDER BY po.otype_id, poi.poi_id
            `,
            [p_id]
        )

        const [tagRows] = await conn.query<(RowDataPacket & ProductTagDTO)[]>(
            `
            SELECT
                e.ptag_id,
                f.ptag_name
            FROM ProductTagMaps e
            INNER JOIN ProductTagLangs f
                ON f.ptag_id = e.ptag_id
            WHERE f.lg_code = ?
              AND e.p_id = ?
            `,
            [lg_code, p_id]
        )

        //   ดึง stock รายคลังจริงของแต่ละ variant
        const [inventoryByVariantRows] = await conn.query<(RowDataPacket & InventoryByVariantDTO)[]>(
            `
            SELECT
                inv.inv_id,
                inv.pv_id,
                inv.loc_id,
                loc.st_id,
                loc.loc_address AS location_name,
                prov.name_in_thai AS province_name,
                COALESCE(inv.on_hand, 0) AS on_hand,
                COALESCE(inv.reserved_qty, 0) AS reserved_qty,
                COALESCE(inv.on_hand, 0) - COALESCE(inv.reserved_qty, 0) AS available_qty
            FROM Inventorys inv
            INNER JOIN ProductVariants pv
                ON pv.pv_id = inv.pv_id
            LEFT JOIN Locations loc
                ON loc.loc_id = inv.loc_id
            LEFT JOIN Provinces prov
                ON prov.id = loc.Provinces_id
            WHERE pv.p_id = ?
            ORDER BY
                inv.pv_id ASC,
                available_qty DESC,
                inv.loc_id ASC
            `,
            [p_id]
        )

        //  ถ้ายังอยากเก็บชื่อจังหวัดรวมไว้แสดงหน้าเดิม ก็ให้ดึงจาก inventory จริง
        const [inventoryStoreRows] = await conn.query<(RowDataPacket & InventoryStoreDTO)[]>(
            `
            SELECT DISTINCT
                prov.name_in_thai AS InventoryStoreProvince
            FROM Inventorys inv
            INNER JOIN ProductVariants pv
                ON pv.pv_id = inv.pv_id
            LEFT JOIN Locations loc
                ON loc.loc_id = inv.loc_id
            LEFT JOIN Provinces prov
                ON prov.id = loc.Provinces_id
            WHERE pv.p_id = ?
            ORDER BY prov.name_in_thai ASC
            `,
            [p_id]
        )

        const [landingPage] = await conn.query<(RowDataPacket & LandignPageNamgeDTO)[]>(
            `
            SELECT
                lp_id,
                lp_title,
                lp_imag_url,
                lp_slug,
                p_id,
                lg_code,
                st_id
            FROM LandingPages
            WHERE st_id = ?
              AND lg_code = ?
              AND p_id = ?
            `,
            [rows[0]!.st_id, lg_code, p_id]
        )

        const groupedOptions: ProductOptionGroupDTO[] = Object.values(
            optionRows.reduce((acc, row) => {
                if (!acc[row.otype_id]) {
                    acc[row.otype_id] = {
                        potn_id: row.potn_id,
                        otype_id: row.otype_id,
                        otype_code: row.otype_code,
                        otype_name: row.otype_name,
                        items: [],
                    }
                }

                acc[row.otype_id]!.items.push({
                    poi_id: row.poi_id,
                    poi_value: row.poi_value,
                })

                return acc
            }, {} as Record<number, ProductOptionGroupDTO>)
        )

        const productRow = rows[0] as ProductShopDetailDTO

        const product: ProductShopDetailDTO = {
            ...productRow,
            thumbnail: imageRows[0]?.ip_image_url || null,
            tags: tagRows.map((tag) => ({
                ptag_id: tag.ptag_id,
                ptag_name: tag.ptag_name,
            })),
        }

        return {
            product,
            images: imageRows,
            variants: variantRows,
            options: groupedOptions,
            InventoryStore: inventoryStoreRows,
            inventoryByVariant: inventoryByVariantRows,
            landingPage,
        }
    } catch (error) {
        console.error("Error fetching product shop by ID:", error)
        throw error
    } finally {
        conn.release()
    }
}




// export async function getProductShopByStId(st_id: number, lg_code: string
// ): Promise<ProductShopDTO[]> {
//     const conn = await pool.getConnection()

//     try {
//         const [rows] = await conn.query<(RowDataPacket & ProductShopDTO)[]>(
//             `
//             SELECT
//                 p.p_id,
//                 pl.p_name,
//                 pl.p_title,
//                 (
//                     SELECT ip.ip_image_url
//                     FROM ImageProduct ip
//                     WHERE ip.p_id = p.p_id
//                     ORDER BY ip.ip_id ASC
//                     LIMIT 1
//                 ) AS ip_image_url,
//                 MIN(pv.pv_price) AS min_price,
//                 MAX(pv.pv_price) AS max_price,
//                 MAX(COALESCE(pv.discount, 0)) AS discount,
//                 CASE
//                     WHEN MIN(pv.pv_price) = MAX(pv.pv_price) THEN 0
//                     ELSE 1
//                 END AS has_price_range
//             FROM Products p
//             LEFT JOIN ProductLangs pl
//                 ON pl.p_id = p.p_id AND pl.lg_code = ?
//             LEFT JOIN ProductVariants pv
//                 ON pv.p_id = p.p_id
//             WHERE p.p_isActive = 1
//                 AND p.st_id = ?
//             GROUP BY p.p_id, pl.p_name, pl.p_title
//             ORDER BY p.p_id DESC
//             `,
//             [lg_code, st_id]
//         )
//         conn.commit();
//         return rows
//     } catch (err) {
//         conn.rollback();
//         throw err;
//     } finally {
//         conn.release()
//     }
// }


