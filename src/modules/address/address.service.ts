import type { RowDataPacket } from "mysql2";
import type { DistrictsDTO, ProvinceDTO, SubDistrictsDTO } from "./address.type.js";
import { pool } from "../../db/pool.js";

export async function listProvinces(): Promise<ProvinceDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & ProvinceDTO)[]>(`SELECT id, code, name_in_thai, name_in_english FROM Provinces order by id asc`);
    return rows;
}

export async function listDistricts(id: number): Promise<DistrictsDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & DistrictsDTO)[]>(`SELECT id, code, name_in_thai, name_in_english, Provinces_id FROM Districts WHERE Provinces_id = ? order by id asc`, [id]);
    return rows;
}

export async function listSubDistricts(id: number): Promise<SubDistrictsDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & SubDistrictsDTO)[]>(`
        SELECT id, code, name_in_thai, name_in_english, latitude, longitude, Districts_id, zip_code FROM Subdistricts 
        WHERE Districts_id = ? order by id asc
        `, [id]);
    return rows;
}