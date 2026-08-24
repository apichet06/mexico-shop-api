import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js"
import type { CreateProductTagsInput, ProductTagsDTO, UpdateProductTagsInput } from "./productTags.type.js"
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { translateProductText } from "../../shared/translate/translate.js";


export async function listProductTags(lg_code: string): Promise<ProductTagsDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & ProductTagsDTO)[]>(`
        SELECT a.*,b.* ,c.e_status,a.e_create_at FROM ProductTags a
        INNER JOIN ProductTagLangs b on a.ptag_id = b.ptag_id
        INNER JOIN Employees c on a.e_id = c.e_id
        WHERE b.lg_code = ?
        ORDER BY b.ptt_id,b.lg_code desc`, [lg_code]
    );
    return rows;
}

export async function create(input: CreateProductTagsInput): Promise<number> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const t = await translateProductText(input.ptag_name);

        const masterData = {
            e_id: input.e_id,
        }
        const [masterRes] = await conn.query<ResultSetHeader>(
            "INSERT INTO ProductTags SET ?",
            masterData
        );

        const ptag_id = masterRes.insertId;
        const langRows = [
            [ptag_id, "th", t.th],
            [ptag_id, "en", t.en],
            [ptag_id, "ja", t.ja],
        ];

        await conn.query(`INSERT INTO ProductTagLangs (ptag_id, lg_code, ptag_name) VALUES ? `, [langRows]);
        await conn.commit();
        return ptag_id;
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    } finally {
        conn.release();
    }
}

export async function update(input: UpdateProductTagsInput): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query("UPDATE ProductTagLangs SET ptag_name = ? WHERE ptt_id = ?", [input.ptag_name, input.ptt_id]);
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    } finally {
        conn.release();
    }
}

export async function Delete(ptag_id: number): Promise<void> {
    try {
        const [resLang] = await pool.query<ResultSetHeader>(
            "DELETE FROM ProductTagLangs WHERE ptag_id = ?", [ptag_id]
        );

        const [res] = await pool.query<ResultSetHeader>(
            "DELETE FROM ProductTags WHERE ptag_id = ?", [ptag_id]
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