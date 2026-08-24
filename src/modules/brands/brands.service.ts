import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { BrandsDTO, CreateBrandsInput } from "./brands.type.js";
import { pool } from "../../db/pool.js";
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";

import { CommonMessages } from "../../shared/messages/common.messages.js";

const BRAND_DUPLICATE_MESSAGE = "แบรนด์นี้มีอยู่ในเว็บไซต์นี้แล้ว";
const BRAND_INDEX_MESSAGE = "โครงสร้างฐานข้อมูลแบรนด์ยังเช็กซ้ำเฉพาะชื่ออยู่ กรุณาเปลี่ยน unique index เป็น (b_name, ctl_id)";

export async function listBrands(): Promise<BrandsDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & BrandsDTO)[]>(`
        SELECT
            a.b_id,
            a.b_name,
            a.e_id,
            a.ctl_id,
            b.ctl_name,
            b.ctl_description,
            a.e_create_at
        FROM Brands a
        LEFT JOIN Catalog b
            ON a.ctl_id = b.ctl_id
        ORDER BY a.b_id DESC
    `);
    return rows;
}

async function getDuplicateBrand(b_name: string, ctl_id: number, excludeBrandId?: number): Promise<BrandsDTO | null> {
    const normalizedName = b_name.trim().toLowerCase();
    const params: Array<string | number> = [normalizedName, ctl_id];
    const excludeSql = excludeBrandId ? "AND b_id <> ?" : "";

    if (excludeBrandId) {
        params.push(excludeBrandId);
    }

    const [rows] = await pool.query<(RowDataPacket & BrandsDTO)[]>(
        `
        SELECT b_id, b_name, e_id, ctl_id, e_create_at
        FROM Brands
        WHERE LOWER(TRIM(b_name)) = ?
          AND ctl_id = ?
          ${excludeSql}
        LIMIT 1
        `,
        params
    );

    return rows[0] ?? null;
}

export async function createBrand(input: CreateBrandsInput): Promise<number> {
    const brandName = String(input.b_name ?? "").trim();
    const ctlId = Number(input.ctl_id ?? 0);

    try {
        const duplicate = await getDuplicateBrand(brandName, ctlId);
        if (duplicate) {
            throw new ApiError(409, BRAND_DUPLICATE_MESSAGE);
        }

        const data = {
            b_name: brandName,
            e_id: input.e_id,
            ctl_id: ctlId,
        };
        const [res] = await pool.query<ResultSetHeader>("INSERT INTO Brands SET ?", data);
        return res.insertId;
    } catch (err) {
        if (isDupError(err)) {
            const duplicateInSameCatalog = await getDuplicateBrand(brandName, ctlId);
            throw new ApiError(409, duplicateInSameCatalog ? BRAND_DUPLICATE_MESSAGE : BRAND_INDEX_MESSAGE);
        }
        throw err;
    }

}


export async function updateBrand(b_id: number, input: Partial<BrandsDTO>): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const brandName = String(input.b_name ?? "").trim();
        const ctlId = Number(input.ctl_id ?? 0);

        const duplicate = await getDuplicateBrand(brandName, ctlId, b_id);
        if (duplicate) {
            throw new ApiError(409, BRAND_DUPLICATE_MESSAGE);
        }

        await conn.query("UPDATE Brands SET b_name = ?, ctl_id = ? WHERE b_id = ?", [brandName, ctlId, b_id]);
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) {
            const brandName = String(input.b_name ?? "").trim();
            const ctlId = Number(input.ctl_id ?? 0);
            const duplicateInSameCatalog = await getDuplicateBrand(brandName, ctlId, b_id);
            throw new ApiError(409, duplicateInSameCatalog ? BRAND_DUPLICATE_MESSAGE : BRAND_INDEX_MESSAGE);
        }
        throw err;
    } finally {
        conn.release();
    }
}

export async function deleteBrand(b_id: number): Promise<void> {
    try {
        const [res] = await pool.query<ResultSetHeader>(
            "DELETE FROM Brands WHERE b_id = ?", [b_id]
        );
        if (res.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }
    } catch (err: any) {
        if (isFkConstraintError(err)) {
            throw new ApiError(409, CommonMessages.used);
        }
        throw err;
    }
}
