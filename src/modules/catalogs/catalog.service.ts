import type { RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import type { Catalog } from "./catalog.type.js";

export async function listCatalogs(): Promise<Catalog[]> {

    const [rows] = await pool.query<RowDataPacket[]>(`SELECT ctl_id, ctl_name, ctl_description FROM Catalog order by ctl_id asc`);
    return rows as Catalog[];
}

