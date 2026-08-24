import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import type { CreateUnitInput, UnitLangsDTO, UpdateUnitInput } from "./unitt.type.js";

import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";

import { CommonMessages } from "../../shared/messages/common.messages.js";
import { translateNameGimini } from "../../shared/translate/translate_gimini.js";

export async function ListUnit(): Promise<UnitLangsDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & UnitLangsDTO)[]>(`
        SELECT a.*,b.* FROM UnitLangs a 
        INNER JOIN Units b on a.u_id = b.u_id 
        ORDER BY a.ul_id,a.lg_code desc`);
    return rows;
}

export async function GetUnitByLang(lang: string): Promise<UnitLangsDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & UnitLangsDTO)[]>(`
        SELECT a.*,b.* FROM UnitLangs a 
        INNER JOIN Units b on a.u_id = b.u_id
        WHERE a.lg_code = ?
        ORDER BY a.ul_id,a.lg_code desc`, [lang]);
    return rows;
}


export async function CreateUnit(input: CreateUnitInput): Promise<number> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const t = await translateNameGimini(input.ul_name);

        const masterData = {
            e_id: input.e_id,
        }
        const [masterRes] = await conn.query<ResultSetHeader>(
            "INSERT INTO Units SET ?",
            masterData
        );

        const u_id = masterRes.insertId;
        const langRows = [
            [u_id, "th", t.th],
            [u_id, "en", t.en],
            [u_id, "ja", t.ja],
        ];

        await conn.query(`INSERT INTO UnitLangs (u_id, lg_code, ul_name) VALUES ? `, [langRows]);
        await conn.commit();
        return u_id;
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    } finally {
        conn.release();
    }
}

export async function UpdateUnit(u_id: number, input: Partial<UpdateUnitInput>): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query("UPDATE UnitLangs SET ul_name = ? WHERE ul_id = ?", [input.ul_name, u_id]);
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    } finally {
        conn.release();
    }
}

export async function DeleteUnit(u_id: number): Promise<void> {
    try {
        const [resLang] = await pool.query<ResultSetHeader>(
            "DELETE FROM UnitLangs WHERE u_id = ?", [u_id]
        );

        const [res] = await pool.query<ResultSetHeader>(
            "DELETE FROM Units WHERE u_id = ?", [u_id]
        );

        if (res.affectedRows === 0 && resLang.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }
    } catch (err: any) {
        if (isFkConstraintError(err)) {
            throw new ApiError(409, CommonMessages.used);
        }
        throw err;
    }

}