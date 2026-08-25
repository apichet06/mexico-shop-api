import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";

type ColumnRow = RowDataPacket & {
    column_name: string;
    column_type: string;
    is_nullable: "YES" | "NO";
};

let locationMexicoSchemaReady: Promise<void> | null = null;

const MEXICO_COLUMNS: Record<string, string> = {
    country_code: "CHAR(2) NULL AFTER st_id",
    colonia: "VARCHAR(160) NULL AFTER loc_address",
    municipality: "VARCHAR(120) NULL AFTER colonia",
    city: "VARCHAR(120) NULL AFTER municipality",
    state: "VARCHAR(100) NULL AFTER city",
    latitude: "DECIMAL(10, 7) NULL AFTER zip_code",
    longitude: "DECIMAL(10, 7) NULL AFTER latitude",
    formatted_address: "VARCHAR(500) NULL AFTER longitude",
};

// เตรียม schema แบบ idempotent เพื่อให้ API รุ่นใหม่ใช้งานกับฐานข้อมูลเดิมได้ทันที
export function ensureLocationMexicoSchema(): Promise<void> {
    locationMexicoSchemaReady ??= (async () => {
        const [columns] = await pool.query<ColumnRow[]>(
            `SELECT COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Locations'`,
        );
        const existing = new Map(columns.map((column) => [column.column_name, column]));

        for (const [name, definition] of Object.entries(MEXICO_COLUMNS)) {
            if (!existing.has(name)) {
                await pool.query(`ALTER TABLE Locations ADD COLUMN \`${name}\` ${definition}`);
            }
        }

        for (const legacyColumn of ["Provinces_id", "Districts_id", "Subdistricts_id"]) {
            const column = existing.get(legacyColumn);
            if (column?.is_nullable === "NO") {
                await pool.query(`ALTER TABLE Locations MODIFY COLUMN \`${legacyColumn}\` ${column.column_type} NULL`);
            }
        }

        const [indexes] = await pool.query<(RowDataPacket & { index_name: string })[]>(
            `SELECT INDEX_NAME AS index_name
             FROM INFORMATION_SCHEMA.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'Locations'
               AND INDEX_NAME = 'idx_locations_mexico_postal'`,
        );
        if (indexes.length === 0) {
            await pool.query("CREATE INDEX idx_locations_mexico_postal ON Locations (country_code, zip_code)");
        }
    })();

    return locationMexicoSchemaReady;
}
