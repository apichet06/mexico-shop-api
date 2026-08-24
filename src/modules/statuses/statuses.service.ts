import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import { ApiError, isDupError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import type { StatusLangDTO, UpdateStatusLangInput } from "./statuses.type.js";

export async function listStatusLangs(lg_code: string): Promise<StatusLangDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & StatusLangDTO)[]>(`
        SELECT
            s.s_id,
            s.s_code,
            sl.lg_code,
            sl.s_name,
            s.s_created_at 
        FROM Status s
        INNER JOIN StatusLangs sl ON sl.s_id = s.s_id
        WHERE sl.lg_code = ?
        ORDER BY s.s_id ASC, sl.lg_code DESC
    `, [lg_code]);

    return rows;
}

export async function updateStatusLang(
    s_id: number,
    lg_code: string,
    input: UpdateStatusLangInput
): Promise<void> {
    try {
        const [res] = await pool.query<ResultSetHeader>(
            "UPDATE StatusLangs SET s_name = ? WHERE s_id = ? AND lg_code = ?",
            [input.s_name, s_id, lg_code]
        );

        if (res.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }
    } catch (err) {
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    }
}
