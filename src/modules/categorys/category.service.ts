

import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { CategoryDTO, CreateCategoryInput, UpdateCategoryInput } from "./category.type.js";
import { pool } from "../../db/pool.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";
import { translateNameGimini } from "../../shared/translate/translate_gimini.js";
import { translateProductText } from "../../shared/translate/translate.js";




export async function listCategorys(): Promise<CategoryDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & CategoryDTO)[]>(`
    SELECT
      a.c_id,b.cl_id, a.c_sort_order, a.e_id, a.ctl_id,
      b.cl_name, b.lg_code,
      c.ctl_name, c.ctl_description, a.e_create_at 
    FROM Categorys a
    INNER JOIN CategoryLangs b ON a.c_id = b.c_id
    INNER JOIN Catalog c ON a.ctl_id = c.ctl_id
    INNER JOIN Employees d ON a.e_id = d.e_id
    ORDER BY b.cl_id, b.lg_code desc
  `);

    return rows;
}

export async function getCategoryByLgCode(lg_code: string, ctl_id?: number): Promise<CategoryDTO[]> {
    const whereConditions = ["b.lg_code = ?"];
    const queryParams: Array<string | number> = [lg_code];

    if (ctl_id && ctl_id > 0) {
        whereConditions.push("a.ctl_id = ?");
        queryParams.push(ctl_id);
    }

    const [rows] = await pool.query<(RowDataPacket & CategoryDTO)[]>(`
    SELECT
      a.c_id,b.cl_id, a.c_sort_order, a.e_id, a.ctl_id,
      b.cl_name, b.lg_code,
      c.ctl_name, c.ctl_description, a.e_create_at 
    FROM Categorys a
    INNER JOIN CategoryLangs b ON a.c_id = b.c_id
    INNER JOIN Catalog c ON a.ctl_id = c.ctl_id
    INNER JOIN Employees d ON a.e_id = d.e_id
    WHERE ${whereConditions.join(" AND ")}
    ORDER BY b.cl_id, b.lg_code desc 
    `, queryParams);
    return rows;
}


export async function createCategory(input: CreateCategoryInput): Promise<number> {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        // 1) แปลภาษาให้ครบ 3 ภาษา
        const t = await translateProductText(input.cl_name);
        const [rows] = await conn.query<any[]>(
            "SELECT COALESCE(MAX(c_sort_order), 0) as maxSort FROM Categorys FOR UPDATE"
        );

        const nextSort = rows[0].maxSort + 1;
        // 2) Insert master (Categorys)
        const masterData = {
            c_sort_order: nextSort,
            e_id: input.e_id,
            ctl_id: input.ctl_id,
        };

        const [masterRes] = await conn.query<ResultSetHeader>(
            "INSERT INTO Categorys SET ?",
            masterData
        );

        const c_id = masterRes.insertId;

        // 3) Insert translations (CategoryLangs) 3 แถว
        // แนะนำทำ UNIQUE (c_id, lg_code) ใน DB กันซ้ำ
        const langRows = [
            [c_id, "th", t.th],
            [c_id, "en", t.en],
            [c_id, "ja", t.ja],
        ];

        await conn.query(`INSERT INTO CategoryLangs (c_id,lg_code, cl_name ) VALUES ? `, [langRows]);
        await conn.commit();
        return c_id;
    } catch (err: any) {

        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.error);
        throw err;
    } finally {
        conn.release();
    }
}

export async function updateCategory(cl_id: number, input: Partial<UpdateCategoryInput>): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query("UPDATE CategoryLangs SET cl_name = ? WHERE cl_id = ?", [input.cl_name, cl_id]);
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    } finally {
        conn.release();
    }
}

export async function deleteCategory(c_id: number): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // ตรวจสอบก่อนว่า category ถูกใช้งานใน Product อยู่หรือไม่
        const [usedRows] = await conn.query<RowDataPacket[]>(
            "SELECT COUNT(*) as count FROM Products WHERE c_id = ?", [c_id]
        );
        if ((usedRows[0] as any).count > 0) {
            throw new ApiError(409, CommonMessages.used);
        }

        await conn.query<ResultSetHeader>("DELETE FROM CategoryLangs WHERE c_id = ?", [c_id]);
        const [res] = await conn.query<ResultSetHeader>("DELETE FROM Categorys WHERE c_id = ?", [c_id]);
        if (res.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }
        await conn.commit();

    } catch (err: any) {
        await conn.rollback();
        if (isFkConstraintError(err)) {
            throw new ApiError(409, CommonMessages.used);
        }
        throw err;
    } finally {
        conn.release();
    }
}
