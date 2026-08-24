import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import type { CreateLocationInput, LocationsDTO, UpdateLocationInput } from "./location.type.js";
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";

import { CommonMessages } from "../../shared/messages/common.messages.js";

const MAX_SELLER_STORE_LOCATIONS = 3;

async function normalizeLocationNames(conn: Awaited<ReturnType<typeof pool.getConnection>>, stId: number): Promise<void> {
    const [rows] = await conn.query<(RowDataPacket & { loc_id: number; is_default: number })[]>(
        "SELECT loc_id, is_default FROM Locations WHERE st_id = ? ORDER BY is_default DESC, loc_id ASC",
        [stId],
    );
    if (rows.length === 0) return;

    const defaultRow = rows.find((row) => Number(row.is_default) === 1) ?? rows[0];
    if (!defaultRow) return;
    let subCount = 1;
    for (const row of rows) {
        const isDefault = row.loc_id === defaultRow.loc_id;
        await conn.query(
            "UPDATE Locations SET is_default = ?, loc_name = ? WHERE loc_id = ?",
            [isDefault ? 1 : 0, isDefault ? "คลังหลัก" : `คลังย่อย ${subCount++}`, row.loc_id],
        );
    }
}

export async function ListLocations(): Promise<LocationsDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & LocationsDTO)[]>(
        `SELECT  * FROM Locations  
        ORDER BY loc_id DESC`
    );
    return rows;
}

export async function getLocationById(st_id: number): Promise<LocationsDTO[]> {
    const conn = await pool.getConnection();
    try {
        await normalizeLocationNames(conn, st_id);
    } finally {
        conn.release();
    }
    const [rows] = await pool.query<(RowDataPacket & LocationsDTO)[]>(
        `SELECT a.*, b.st_company_name, c.name_in_thai as province_name, d.name_in_thai as district_name, e.name_in_thai as subdistrict_name
        FROM Locations a 
        INNER JOIN Store b ON a.st_id = b.st_id
        INNER JOIN Provinces c ON a.Provinces_id = c.id
        INNER JOIN Districts d ON a.Districts_id = d.id
        INNER JOIN Subdistricts e ON a.Subdistricts_id = e.id
        WHERE a.st_id = ?`,
        [st_id]
    );
    return rows;
}

export async function CreateLocation(input: CreateLocationInput): Promise<number> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const stId = Number(input.st_id);
        if (!stId) {
            throw new ApiError(400, "รหัสร้านไม่ถูกต้อง");
        }
        const [storeRows] = await conn.query<RowDataPacket[]>(
            `SELECT st_id FROM Store WHERE st_id = ? LIMIT 1`,
            [stId],
        );
        if (!storeRows[0]) {
            throw new ApiError(404, CommonMessages.notFound);
        }
        const [locationRows] = await conn.query<RowDataPacket[]>(
            `SELECT COUNT(*) AS total FROM Locations WHERE st_id = ?`,
            [stId],
        );
        const locationCount = Number(locationRows[0]?.total ?? 0);
        if (locationCount >= MAX_SELLER_STORE_LOCATIONS) {
            throw new ApiError(400, `เพิ่มคลังสินค้า/สาขาได้สูงสุด ${MAX_SELLER_STORE_LOCATIONS} แห่ง`);
        }

        const defaultValue = input.is_default as unknown;
        const isDefault = defaultValue === true || defaultValue === 1 || defaultValue === "1";

        if (isDefault) {
            const [oldDefaultRows] = await conn.query<RowDataPacket[]>(
                "SELECT loc_id FROM Locations WHERE st_id = ? AND is_default = 1 ORDER BY loc_id ASC",
                [stId],
            );
            const [countRows] = await conn.query<RowDataPacket[]>(
                "SELECT COUNT(*) as count FROM Locations WHERE st_id = ? AND is_default = 0",
                [stId],
            );
            const subWarehouseCount = Number(countRows[0]?.count ?? 0);

            for (const [index, row] of oldDefaultRows.entries()) {
                await conn.query(
                    "UPDATE Locations SET loc_name = ? WHERE loc_id = ?",
                    [`คลังย่อย ${subWarehouseCount + index + 1}`, row.loc_id],
                );
            }
            await conn.query("UPDATE Locations SET is_default = 0 WHERE st_id = ?", [stId]);
        }

        let loc_name: string;
        if (isDefault) {
            loc_name = "คลังหลัก";
        } else {
            const [countRows] = await conn.query<RowDataPacket[]>(
                "SELECT COUNT(*) as count FROM Locations WHERE st_id = ? AND is_default = 0",
                [stId]
            );
            const count = (countRows[0] as any).count as number;
            loc_name = `คลังย่อย ${count + 1}`;
        }

        const [result] = await conn.query<ResultSetHeader>(
            "INSERT INTO Locations SET ?",
            [{
                st_id: stId,
                Subdistricts_id: Number(input.Subdistricts_id),
                Districts_id: Number(input.Districts_id),
                Provinces_id: Number(input.Provinces_id),
                loc_address: input.loc_address,
                zip_code: input.zip_code,
                is_default: isDefault ? 1 : 0,
                loc_name,
            }]
        );
        await normalizeLocationNames(conn, stId);
        await conn.commit();
        return result.insertId;

    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) {
            throw new ApiError(409, CommonMessages.isExits);
        }
        throw err;
    } finally {
        conn.release();
    }
}

export async function UpdateLocation(loc_id: number, input: Partial<UpdateLocationInput>): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const updateData: any = { ...input };
        const defaultValue = input.is_default as unknown;
        const nextIsDefault = defaultValue === true || defaultValue === 1 || defaultValue === "1";

        if (nextIsDefault) {
            // หา old default ก่อน reset
            const [oldDefaultRows] = await conn.query<RowDataPacket[]>(
                "SELECT loc_id FROM Locations WHERE st_id = ? AND is_default = 1 AND loc_id != ?",
                [input.st_id, loc_id]
            );

            // นับจำนวนคลังย่อยที่มีอยู่ (ไม่นับตัวที่กำลัง promote)
            const [countRows] = await conn.query<RowDataPacket[]>(
                "SELECT COUNT(*) as count FROM Locations WHERE st_id = ? AND is_default = 0 AND loc_id != ?",
                [input.st_id, loc_id]
            );
            const count = (countRows[0] as any).count as number;

            await conn.query("UPDATE Locations SET is_default = 0 WHERE st_id = ?", [input.st_id]);

            // rename old default → คลังย่อย N
            if (oldDefaultRows.length > 0) {
                await conn.query(
                    "UPDATE Locations SET loc_name = ? WHERE loc_id = ?",
                    [`คลังย่อย ${count + 1}`, oldDefaultRows[0]!.loc_id]
                );
            }

            updateData.loc_name = "คลังหลัก";
            updateData.is_default = 1;
        } else if (input.is_default !== undefined) {
            const [currentRows] = await conn.query<RowDataPacket[]>(
                "SELECT st_id, is_default FROM Locations WHERE loc_id = ? LIMIT 1",
                [loc_id],
            );
            const current = currentRows[0];
            if (!current) {
                throw new ApiError(404, CommonMessages.notFound);
            }

            const [countRows] = await conn.query<RowDataPacket[]>(
                "SELECT COUNT(*) as count FROM Locations WHERE st_id = ? AND is_default = 0 AND loc_id != ?",
                [input.st_id, loc_id],
            );
            const count = Number(countRows[0]?.count ?? 0);
            updateData.loc_name = `คลังย่อย ${count + 1}`;
            updateData.is_default = 0;

            if (current.is_default === 1) {
                const [nextDefaultRows] = await conn.query<RowDataPacket[]>(
                    "SELECT loc_id FROM Locations WHERE st_id = ? AND loc_id != ? ORDER BY loc_id ASC LIMIT 1",
                    [input.st_id, loc_id],
                );
                const nextDefault = nextDefaultRows[0];
                if (nextDefault) {
                    await conn.query(
                        "UPDATE Locations SET is_default = 1, loc_name = ? WHERE loc_id = ?",
                        ["คลังหลัก", nextDefault.loc_id],
                    );
                }
            }
        }

        const [result] = await conn.query<ResultSetHeader>(
            "UPDATE Locations SET ? WHERE loc_id = ?",
            [updateData, loc_id]
        );
        if (result.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }
        if (input.st_id) {
            await normalizeLocationNames(conn, Number(input.st_id));
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) {
            throw new ApiError(409, CommonMessages.isExits);
        }
        throw err;
    } finally {
        conn.release();
    }
}

type LocationRow = RowDataPacket & {
    loc_id: number;
    st_id: number;
    is_default: number;
};


export async function DeleteLocation(loc_id: number): Promise<void> {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();
        // 1) ดึงข้อมูล location ที่จะลบก่อน
        const [rows] = await conn.query<LocationRow[]>(`SELECT loc_id, st_id, is_default FROM Locations WHERE loc_id = ?`, [loc_id]);
        if (rows.length === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        const target = rows[0]!;
        // 2) ลบ location
        const [result] = await conn.query<ResultSetHeader>(`DELETE FROM Locations WHERE loc_id = ?`, [loc_id]);

        if (result.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        // 3) ถ้าตัวที่ลบเป็นที่อยู่หลัก ให้หาอันใหม่ในร้านเดียวกัน
        if (target.is_default === 1) {
            const [remaining] = await conn.query<LocationRow[]>(`SELECT loc_id FROM Locations WHERE st_id = ? ORDER BY loc_id ASC LIMIT 1`, [target.st_id]);

            // 4) ถ้ายังมี location เหลืออยู่ ค่อยตั้งเป็น default
            if (remaining.length > 0) {
                await conn.query(`UPDATE Locations  SET is_default = 1 WHERE loc_id = ?`, [remaining[0]!.loc_id]);
            }
        }
        await normalizeLocationNames(conn, target.st_id);

        await conn.commit();
        return;
    } catch (err) {
        await conn.rollback();
        if (isFkConstraintError(err)) {
            throw new ApiError(409, CommonMessages.used);
        }
        throw err;
    } finally {
        conn.release();
    }
}
