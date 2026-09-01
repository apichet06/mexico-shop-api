import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";

let orderShippingColumnsReady: Promise<void> | null = null;
let orderShipmentTablesReady: Promise<void> | null = null;
let refundColumnsReady: Promise<void> | null = null;
let refundMethodColumnReady: Promise<void> | null = null;
let refundImagesTableReady: Promise<void> | null = null;

// สร้างตารางรูปภาพคำขอคืนเงินถ้ายังไม่มี เพื่อรองรับหลักฐานจาก buyer
export async function ensureRefundImagesTable(): Promise<void> {
    refundImagesTableReady ??= pool.query(
        `CREATE TABLE IF NOT EXISTS Refund_images (
            rfi_id INT AUTO_INCREMENT PRIMARY KEY,
            refund_id INT NOT NULL,
            url_image TEXT NOT NULL,
            created_at DATETIME NOT NULL,
            INDEX idx_refund_id (refund_id)
        )`
    ).then(() => undefined);

    return refundImagesTableReady;
}

// เพิ่ม column เลข tracking พัสดุคืนสินค้าใน Refunds ถ้ายังไม่มี
export async function ensureRefundReturnTrackingColumn(): Promise<void> {
    refundColumnsReady ??= pool.query<(RowDataPacket & { column_name: string })[]>(
        `SELECT COLUMN_NAME AS column_name
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'Refunds'
           AND COLUMN_NAME = 'return_tracking'`
    )
        .then(async ([columns]) => {
            if (columns.length === 0) {
                await pool.query("ALTER TABLE Refunds ADD COLUMN return_tracking VARCHAR(255) NULL AFTER remark");
            }
        })
        .then(() => undefined);

    return refundColumnsReady;
}

// รองรับ Mercado Pago พร้อมเก็บค่า omise ไว้สำหรับประวัติรายการเก่า
export async function ensureRefundMethodColumn(): Promise<void> {
    refundMethodColumnReady ??= pool.query<(RowDataPacket & { column_name: string; column_type: string })[]>(
        `SELECT COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'Refunds'
           AND COLUMN_NAME = 'refund_method'`
    )
        .then(async ([columns]) => {
            if (columns.length === 0) {
                await pool.query("ALTER TABLE Refunds ADD COLUMN refund_method ENUM('mercado_pago', 'manual', 'omise') NULL AFTER status");
            } else if (!columns[0]?.column_type.includes("mercado_pago")) {
                await pool.query("ALTER TABLE Refunds MODIFY COLUMN refund_method ENUM('mercado_pago', 'manual', 'omise') NULL");
            }
        })
        .then(() => undefined);

    return refundMethodColumnReady;
}

// เตรียม column ขนส่งใน Orders เช่น tracking, label, zone และข้อมูลต้นทุน shipping
export async function ensureOrderShipmentLabelColumn(): Promise<void> {
    orderShippingColumnsReady ??= pool.query<(RowDataPacket & { column_name: string })[]>(
        `SELECT COLUMN_NAME AS column_name
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'Orders'
           AND COLUMN_NAME IN ('label_url', 'provider_shipping_cost')`
    )
        .then(async ([columns]) => {
            const existing = new Set(columns.map((column) => column.column_name));
            if (!existing.has("label_url")) {
                // ผู้ให้บริการขนส่งส่ง label URL กลับมาหลังสร้าง shipment; เก็บแยกจาก tracking_url เพื่อใช้พิมพ์ใบปะหน้ากล่องโดยตรง
                await pool.query("ALTER TABLE Orders ADD COLUMN label_url TEXT NULL AFTER tracking_url");
            }
            if (!existing.has("provider_shipping_cost")) {
                await pool.query("ALTER TABLE Orders ADD COLUMN provider_shipping_cost DECIMAL(10,2) NULL AFTER shipping_fee");
            }
        })
        .then(() => undefined);

    return orderShippingColumnsReady;
}

// สร้างตาราง shipment, shipment item และ event tracking สำหรับ order ถ้ายังไม่มี
export async function ensureOrderShipmentTables(): Promise<void> {
    orderShipmentTablesReady ??= (async () => {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS Order_shipments (
                os_id INT NOT NULL AUTO_INCREMENT,
                or_id INT NOT NULL,
                loc_id INT NOT NULL,
                shipment_no VARCHAR(80) NOT NULL,
                status VARCHAR(40) NOT NULL DEFAULT 'planned',
                tracking_no VARCHAR(120) NULL,
                tracking_url TEXT NULL,
                label_url TEXT NULL,
                sender_name VARCHAR(255) NOT NULL,
                sender_phone VARCHAR(60) NULL,
                sender_email VARCHAR(255) NULL,
                sender_address TEXT NOT NULL,
                sender_zip_code VARCHAR(20) NULL,
                sender_province_name VARCHAR(255) NULL,
                sender_district_name VARCHAR(255) NULL,
                sender_subdistrict_name VARCHAR(255) NULL,
                recipient_name VARCHAR(255) NOT NULL,
                recipient_phone VARCHAR(60) NULL,
                recipient_address TEXT NOT NULL,
                recipient_zip_code VARCHAR(20) NULL,
                recipient_province_name VARCHAR(255) NULL,
                recipient_district_name VARCHAR(255) NULL,
                recipient_subdistrict_name VARCHAR(255) NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (os_id),
                UNIQUE KEY uq_order_shipments_order_location (or_id, loc_id),
                KEY idx_order_shipments_order (or_id),
                KEY idx_order_shipments_location (loc_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS Order_shipment_items (
                osi_id INT NOT NULL AUTO_INCREMENT,
                os_id INT NOT NULL,
                or_id INT NOT NULL,
                oi_id INT NOT NULL,
                pv_id INT NOT NULL,
                qty INT NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (osi_id),
                UNIQUE KEY uq_order_shipment_items_line (os_id, oi_id, pv_id),
                KEY idx_order_shipment_items_order (or_id),
                KEY idx_order_shipment_items_item (oi_id)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS Order_shipment_events (
                ose_id INT NOT NULL AUTO_INCREMENT,
                os_id INT NOT NULL,
                or_id INT NOT NULL,
                tracking_code VARCHAR(120) NOT NULL,
                courier_tracking_code VARCHAR(120) NULL,
                status VARCHAR(40) NULL,
                title VARCHAR(500) NOT NULL,
                description TEXT NULL,
                location VARCHAR(255) NULL,
                occurred_at DATETIME NOT NULL,
                raw_json LONGTEXT NULL,
                event_hash CHAR(64) NOT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (ose_id),
                UNIQUE KEY uq_order_shipment_events_hash (event_hash),
                KEY idx_order_shipment_events_order (or_id),
                KEY idx_order_shipment_events_shipment (os_id),
                KEY idx_order_shipment_events_tracking (tracking_code),
                KEY idx_order_shipment_events_occurred (occurred_at)
            )
        `);
    })();

    return orderShipmentTablesReady;
}
