import { pool } from "../dist/db/pool.js";

const applyChanges = process.argv.includes("--apply");

function toEnglishWarehouseName(currentName) {
    if (currentName === "คลังหลัก") return "Main Warehouse";

    const subWarehouse = /^คลังย่อย\s+(\d+)$/.exec(currentName);
    if (subWarehouse) return `Sub Warehouse ${subWarehouse[1]}`;

    return null;
}

async function main() {
    const [rows] = await pool.query(
        `SELECT loc_id, st_id, loc_name
         FROM Locations
         WHERE loc_name = 'คลังหลัก' OR loc_name REGEXP '^คลังย่อย[[:space:]]+[0-9]+$'
         ORDER BY st_id, loc_id`,
    );

    const pending = rows.map((row) => ({
        ...row,
        next_loc_name: toEnglishWarehouseName(row.loc_name),
    })).filter((row) => row.next_loc_name);

    console.log(applyChanges ? "Applying warehouse-name migration:" : "Warehouse-name migration dry run:", pending);
    if (!applyChanges || pending.length === 0) return;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        for (const row of pending) {
            // เทียบชื่อเดิมใน WHERE เพื่อไม่เขียนทับหากข้อมูลถูกแก้ระหว่างรัน migration
            await connection.query(
                "UPDATE Locations SET loc_name = ? WHERE loc_id = ? AND loc_name = ?",
                [row.next_loc_name, row.loc_id, row.loc_name],
            );
        }

        await connection.commit();
        console.log(`Migrated ${pending.length} warehouse names to English.`);
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

try {
    await main();
} finally {
    await pool.end();
}
