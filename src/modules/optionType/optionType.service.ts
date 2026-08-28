
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import type { OptionType, OptionTypeInput } from "./optionType.type.js";
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { translateNameGimini } from "../../shared/translate/translate_gimini.js";

export async function List(language = "es"): Promise<OptionType[]> {
    const [rows] = await pool.query<(RowDataPacket & OptionType)[]>(`
        SELECT
            ot.otype_id,
            ot.otype_code,
            COALESCE(otl.otl_name, ot.otype_name) AS otype_name
        FROM OptionTypes ot
        LEFT JOIN OptionTypeLangs otl
            ON otl.otype_id = ot.otype_id AND otl.lg_code = ?
        ORDER BY ot.otype_id ASC
    `, [language]);
    return rows;
}

export async function Create(input: OptionTypeInput): Promise<number> {
    const translations = await translateNameGimini(
        input.otype_name,
        "product option type label, such as color, size, material, or flavor"
    );
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [result] = await conn.query<ResultSetHeader>(
            `INSERT INTO OptionTypes (otype_code, otype_name) VALUES (?, ?)`,
            [input.otype_code, translations.es]
        );
        await conn.query(
            `INSERT INTO OptionTypeLangs (otype_id, lg_code, otl_name) VALUES ?`,
            [[
                [result.insertId, "es", translations.es],
                [result.insertId, "en", translations.en],
                [result.insertId, "ja", translations.ja],
                [result.insertId, "th", translations.th],
            ]]
        );
        await conn.commit();
        return result.insertId;
    } catch (error) {
        await conn.rollback();
        if (isDupError(error)) throw new ApiError(409, "El código o nombre del tipo de opción ya existe.");
        throw error;
    } finally {
        conn.release();
    }
}

export async function Update(otypeId: number, input: OptionTypeInput): Promise<void> {
    const translations = await translateNameGimini(
        input.otype_name,
        "product option type label, such as color, size, material, or flavor"
    );
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [result] = await conn.query<ResultSetHeader>(
            `UPDATE OptionTypes SET otype_code = ?, otype_name = ? WHERE otype_id = ?`,
            [input.otype_code, translations.es, otypeId]
        );
        if (result.affectedRows === 0) throw new ApiError(404, CommonMessages.notFound);
        await conn.query(
            `INSERT INTO OptionTypeLangs (otype_id, lg_code, otl_name)
             VALUES ?
             ON DUPLICATE KEY UPDATE otl_name = VALUES(otl_name)`,
            [[
                [otypeId, "es", translations.es],
                [otypeId, "en", translations.en],
                [otypeId, "ja", translations.ja],
                [otypeId, "th", translations.th],
            ]]
        );
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        if (isDupError(error)) throw new ApiError(409, "El código o nombre del tipo de opción ya existe.");
        throw error;
    } finally {
        conn.release();
    }
}

export async function Delete(otypeId: number): Promise<void> {
    try {
        const [result] = await pool.query<ResultSetHeader>(
            `DELETE FROM OptionTypes WHERE otype_id = ?`,
            [otypeId]
        );
        if (result.affectedRows === 0) throw new ApiError(404, CommonMessages.notFound);
    } catch (error) {
        if (isFkConstraintError(error)) throw new ApiError(409, CommonMessages.used);
        throw error;
    }
}

