import type { RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import type { productStatusDTO } from "./productStatus.type.js";

export async function list(): Promise<productStatusDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & productStatusDTO)[]>(
        `SELECT * FROM ProductStatus ORDER BY ps_id ASC`
    )
    return rows;

}