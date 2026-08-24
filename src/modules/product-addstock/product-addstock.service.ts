import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import type { AddStockProduct, InactiveStockResponse, InventoryLogResponse, ReduceStoskProduct, StockProductResponse } from "./product-addstock.type.js";
import { ApiError } from "../../shared/errors/ApiError.js";

export async function list(st_id: number, log_code: string): Promise<StockProductResponse[]> {

    const [rows] = await pool.query<(RowDataPacket[]) & StockProductResponse[]>(`
 
            SELECT  c.*,b.p_name,  
                        b.lg_code,
                        d.on_hand, 
                        d.reserved_qty,
                        d.loc_id,
                        g.name_in_thai as province,
                        f.loc_name,
                        d.inv_id ,
                        (SELECT GROUP_CONCAT(g.poi_value ORDER BY f.poi_id SEPARATOR '/')
                            FROM VariantOptionItems f
                            JOIN ProductOptionItems g ON g.poi_id = f.poi_id
                            WHERE f.pv_id = c.pv_id
                        ) AS poi_values,
                        j.ul_name 
            FROM Products a 
            INNER JOIN ProductLangs b 
            ON a.p_id = b.p_id
            INNER JOIN ProductVariants c 
            ON c.p_id = a.p_id 
            INNER JOIN Inventorys d ON c.pv_id = d.pv_id
            INNER JOIN Locations f ON f.loc_id = d.loc_id
            INNER JOIN Provinces g ON f.Provinces_id = g.id
            INNER JOIN Units h ON h.u_id = c.unit_id
            INNER JOIN UnitLangs j ON j.u_id = h.u_id
            WHERE b.lg_code = ? and a.st_id = ? and j.lg_code = ? and f.st_id = ?
            order by a.p_id desc`, [log_code, st_id, log_code, st_id]);


    return rows;

}

async function InventoryRow(conn: PoolConnection, pv_id: number, loc_id: number): Promise<RowDataPacket[]> {
    const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT *  FROM Inventorys WHERE pv_id = ? AND loc_id = ?`, [pv_id, loc_id]
    );
    return rows;
}

export async function addStock(data: AddStockProduct): Promise<number> {
    const conn = await pool.getConnection();
    try {
        const { pv_id, loc_id, addOn_hand, e_id, st_id } = data;

        await conn.beginTransaction();

        const [updateRows] = await conn.query<ResultSetHeader>(
            `UPDATE Inventorys
             SET on_hand = on_hand + ?
             WHERE pv_id = ? AND loc_id = ?`,
            [addOn_hand, pv_id, loc_id]
        );

        if (updateRows.affectedRows === 0) {
            throw new ApiError(404, "ไม่พบสินค้าในคลัง");
        }

        const inventoryRows = await InventoryRow(conn, pv_id, loc_id);

        const inv_id = inventoryRows[0]?.inv_id;
        if (!inv_id) {
            throw new ApiError(404, "ไมพบ Inventory ID");
        }

        await conn.query(
            `INSERT INTO InventoryLog(on_hand, ivnl_status, pv_id, inv_id, e_id, st_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [addOn_hand, "เพิ่ม", pv_id, inv_id, e_id, st_id]
        );

        await conn.commit();
        return updateRows.affectedRows;
    } catch (err) {
        await conn.rollback();
        console.error(`Error add stock: ${err}`);
        throw err;
    } finally {
        conn.release();
    }
}

export async function reduceStock(data: ReduceStoskProduct): Promise<number> {
    const conn = await pool.getConnection();
    try {
        const { pv_id, loc_id, reduceOn_hand, e_id, st_id } = data;

        await conn.beginTransaction();

        const [updateRows] = await conn.query<ResultSetHeader>(
            `UPDATE Inventorys
             SET on_hand = on_hand - ?
             WHERE pv_id = ? AND loc_id = ? AND on_hand >= ?`,
            [reduceOn_hand, pv_id, loc_id, reduceOn_hand]
        );

        if (updateRows.affectedRows === 0) {
            throw new ApiError(400, "สินค้าไม่เพียงพอสำหรับลดจำนวน");
        }

        const inventoryRows = await InventoryRow(conn, pv_id, loc_id);

        const inv_id = inventoryRows[0]?.inv_id;
        if (!inv_id) {
            throw new ApiError(404, "ไม่พบ Inventory ID");
        }

        await conn.query(
            `INSERT INTO InventoryLog (on_hand, ivnl_status, pv_id, inv_id, e_id, st_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [reduceOn_hand, "ลด", pv_id, inv_id, e_id, st_id]
        );

        await conn.commit();
        return updateRows.affectedRows;
    } catch (err) {
        await conn.rollback();
        console.error(`Error reduce stock: ${err}`);
        throw err;
    } finally {
        conn.release();
    }
}


export async function ListInventoryLog(st_id: number, inv_id: number): Promise<InventoryLogResponse[]> {
    const [rows] = await pool.query<(RowDataPacket[]) & InventoryLogResponse[]>(`
                    SELECT a.*,(SELECT GROUP_CONCAT(g.poi_value ORDER BY f.poi_id SEPARATOR '/')
                            FROM VariantOptionItems f
                            JOIN ProductOptionItems g ON g.poi_id = f.poi_id
                            WHERE f.pv_id = a.pv_id
                        ) AS poi_values,c.e_firstname,b.pv_sku FROM InventoryLog a 
                        INNER JOIN ProductVariants b 
                        ON a.pv_id = b.pv_id
                        INNER JOIN Employees c 
                        ON c.e_id = a.e_id
                        WHERE a.st_id = ? AND a.inv_id = ?
                        ORDER BY a.create_at DESC`, [st_id, inv_id]);
    return rows;

}

export async function ListInventoryMovement(st_id: number, log_code: string): Promise<InventoryLogResponse[]> {
    const [rows] = await pool.query<(RowDataPacket[]) & InventoryLogResponse[]>(`
                    SELECT
                        a.*,
                        (SELECT GROUP_CONCAT(g.poi_value ORDER BY f.poi_id SEPARATOR '/')
                            FROM VariantOptionItems f
                            JOIN ProductOptionItems g ON g.poi_id = f.poi_id
                            WHERE f.pv_id = a.pv_id
                        ) AS poi_values,
                        c.e_firstname,
                        b.pv_sku,
                        pl.p_name,
                        l.loc_name,
                        pr.name_in_thai AS province
                    FROM InventoryLog a
                    INNER JOIN ProductVariants b ON a.pv_id = b.pv_id
                    INNER JOIN Products p ON p.p_id = b.p_id
                    INNER JOIN ProductLangs pl ON pl.p_id = p.p_id AND pl.lg_code = ?
                    INNER JOIN Inventorys i ON i.inv_id = a.inv_id
                    INNER JOIN Locations l ON l.loc_id = i.loc_id
                    INNER JOIN Provinces pr ON pr.id = l.Provinces_id
                    INNER JOIN Employees c ON c.e_id = a.e_id
                    WHERE a.st_id = ?
                    ORDER BY a.create_at DESC`, [log_code, st_id]);

    return rows;
}

export async function ListInactiveStock(st_id: number, log_code: string, days: number): Promise<InactiveStockResponse[]> {
    const inactiveDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 60;

    const [rows] = await pool.query<(RowDataPacket[]) & InactiveStockResponse[]>(`
                    SELECT
                        inv.inv_id,
                        p.st_id,
                        pv.pv_id,
                        inv.loc_id,
                        p.p_id,
                        pl.p_name,
                        pv.pv_sku,
                        pv.image_url,
                        inv.on_hand,
                        inv.reserved_qty,
                        l.loc_name,
                        pr.name_in_thai AS province,
                        sales.last_sold_at,
                        COALESCE(sales.sold_qty, 0) AS sold_qty,
                        CASE
                            WHEN sales.last_sold_at IS NULL THEN NULL
                            ELSE DATEDIFF(CURDATE(), DATE(sales.last_sold_at))
                        END AS inactive_days,
                        (SELECT GROUP_CONCAT(poi.poi_value ORDER BY voi.poi_id SEPARATOR '/')
                            FROM VariantOptionItems voi
                            JOIN ProductOptionItems poi ON poi.poi_id = voi.poi_id
                            WHERE voi.pv_id = pv.pv_id
                        ) AS poi_values
                    FROM ProductVariants pv
                    INNER JOIN Products p ON p.p_id = pv.p_id
                    INNER JOIN ProductLangs pl ON pl.p_id = p.p_id AND pl.lg_code = ?
                    LEFT JOIN Inventorys inv ON inv.pv_id = pv.pv_id
                    LEFT JOIN Locations l ON l.loc_id = inv.loc_id AND l.st_id = p.st_id
                    LEFT JOIN Provinces pr ON pr.id = l.Provinces_id
                    LEFT JOIN (
                        SELECT
                            oi.pv_id,
                            MAX(o.created_at) AS last_sold_at,
                            SUM(oi.qty) AS sold_qty
                        FROM Order_items oi
                        INNER JOIN Orders o ON o.or_id = oi.or_id
                        INNER JOIN Status os ON os.s_id = o.s_id
                        WHERE os.s_code IN ('CONFIRMED', 'PROCESSING', 'PACKED', 'READY_TO_SHIP')
                        GROUP BY oi.pv_id
                    ) sales ON sales.pv_id = pv.pv_id
                    WHERE p.st_id = ?
                      AND (sales.last_sold_at IS NULL OR sales.last_sold_at < DATE_SUB(NOW(), INTERVAL ? DAY))
                    ORDER BY sales.last_sold_at IS NULL DESC, sales.last_sold_at ASC, COALESCE(inv.on_hand, 0) DESC`,
        [log_code, st_id, inactiveDays]
    );

    return rows;
}

