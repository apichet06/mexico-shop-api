import { pool } from "../../db/pool.js";

let storeShippingCarriersTableReady: Promise<void> | null = null;

// ตารางเก็บ subset ขนส่งที่แต่ละร้านเลือกใช้ ไม่มีแถว = ร้านยังไม่ตั้งค่า ใช้ขนส่งกลางทั้งหมด (default)
export async function ensureStoreShippingCarriersTable(): Promise<void> {
    storeShippingCarriersTableReady ??= pool.query(
        `CREATE TABLE IF NOT EXISTS Store_shipping_carriers (
            ssc_id INT NOT NULL AUTO_INCREMENT,
            st_id INT NOT NULL,
            sc_id INT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (ssc_id),
            UNIQUE KEY uq_store_shipping_carriers (st_id, sc_id),
            KEY idx_store_shipping_carriers_store (st_id)
        )`
    ).then(() => undefined);

    return storeShippingCarriersTableReady;
}
