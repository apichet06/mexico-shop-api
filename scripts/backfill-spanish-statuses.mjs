import { pool } from "../dist/db/pool.js";

const applyChanges = process.argv.includes("--apply");

// ชื่อสถานะภาษาสเปนผูกกับ s_code เพื่อไม่อ้างอิง s_id ที่อาจต่างกันในแต่ละฐานข้อมูล
const spanishStatusNames = {
    PENDING: "Pendiente",
    CONFIRMED: "Confirmado",
    PROCESSING: "En preparación",
    PACKED: "Empaquetado",
    READY_TO_SHIP: "Listo para enviar",
    CANCELLED: "Cancelado",
    REFUNDED: "Reembolsado",
    DELIVERED: "Entregado",
    REVIEWED: "Calificado y reseñado",
    RETURN_REQUESTED: "Devolución/reembolso pendiente",
    RETURN_REQUESTED_COMPLETED: "Devolución/reembolso completado",
    RECEIVED: "Recibido",
    AUTO_RECEIVED: "Recepción confirmada automáticamente",
};

async function main() {
    const [statuses] = await pool.query(
        `SELECT s.s_id, s.s_code
         FROM Status s
         WHERE NOT EXISTS (
             SELECT 1
             FROM StatusLangs sl
             WHERE sl.s_id = s.s_id AND sl.lg_code = 'es'
         )
         ORDER BY s.s_id`,
    );

    const pending = statuses
        .filter((status) => spanishStatusNames[status.s_code])
        .map((status) => ({
            ...status,
            s_name: spanishStatusNames[status.s_code],
        }));

    console.log(applyChanges ? "Applying Spanish status backfill:" : "Spanish status backfill dry run:", pending);
    if (!applyChanges || pending.length === 0) return;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        for (const status of pending) {
            // เช็กซ้ำในคำสั่ง INSERT เพื่อให้สคริปต์รันซ้ำได้โดยไม่สร้างข้อมูลซ้ำ
            await connection.query(
                `INSERT INTO StatusLangs (s_name, s_id, lg_code)
                 SELECT ?, ?, 'es'
                 WHERE NOT EXISTS (
                     SELECT 1 FROM StatusLangs WHERE s_id = ? AND lg_code = 'es'
                 )`,
                [status.s_name, status.s_id, status.s_id],
            );
        }

        await connection.commit();
        console.log(`Inserted ${pending.length} Spanish status translations.`);
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
