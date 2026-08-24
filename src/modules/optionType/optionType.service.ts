
import type { RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import type { OptionType } from "./optionType.type.js";

export async function List(): Promise<OptionType[]> {
    const [rows] = await pool.query<(RowDataPacket[]) & OptionType[]>(`SELECT * FROM OptionTypes ORDER BY otype_id asc`)
    return rows;
}

