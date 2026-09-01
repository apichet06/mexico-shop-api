import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../dist/db/pool.js";

const apply = process.argv.includes("--apply");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const backupDir = resolve(scriptDir, "..", "backups");
const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupPath = resolve(backupDir, `order-transactions-${timestamp}.json.gz`);

const fullTables = [
  "CouponRedemptions",
  "Estimate_delivery_image",
  "Estimate_delivery",
  "Order_inventory_reservations",
  "Order_shipment_events",
  "Order_shipment_items",
  "Order_shipments",
  "Payment_orders",
  "Payments",
  "Payout_items",
  "Payout_orders",
  "Payout_history",
  "Payouts",
  "Refund_images",
  "Refund_items",
  "Refunds",
  "Return_items",
  "Returns",
  "Order_items",
  "Orders",
  "Shipping_rates",
  "Postcode_zone_rules",
];

const [tableRows] = await pool.query(`
  SELECT TABLE_NAME AS table_name
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
`);
const tables = new Set(tableRows.map((row) => row.table_name));
const existingFullTables = fullTables.filter((table) => tables.has(table));

const backup = {
  metadata: {
    created_at: new Date().toISOString(),
    purpose: "Backup before clearing test orders and removing legacy shipping rates",
  },
  tables: {},
  filtered: {},
};

for (const table of existingFullTables) {
  const [rows] = await pool.query(`SELECT * FROM \`${table}\``);
  backup.tables[table] = rows;
}

if (tables.has("Notifications")) {
  const [rows] = await pool.query("SELECT * FROM Notifications WHERE ref_type = 'ORDER'");
  backup.filtered.Notifications_ORDER = rows;
}
if (tables.has("UserCoupons")) {
  const [rows] = await pool.query("SELECT * FROM UserCoupons WHERE or_id IS NOT NULL");
  backup.filtered.UserCoupons_linked_to_orders = rows;
}
if (tables.has("Inventorys") && tables.has("Order_inventory_reservations")) {
  const [rows] = await pool.query(`
    SELECT i.*
    FROM Inventorys i
    WHERE i.inv_id IN (SELECT DISTINCT inv_id FROM Order_inventory_reservations)
    ORDER BY i.inv_id
  `);
  backup.filtered.Inventorys_affected = rows;
}
if (tables.has("Shipping_carriers")) {
  const [rows] = await pool.query("SELECT * FROM Shipping_carriers ORDER BY sc_id");
  backup.tables.Shipping_carriers = rows;
}

await mkdir(backupDir, { recursive: true });
await writeFile(backupPath, gzipSync(JSON.stringify(backup)));
console.log(`Backup: ${backupPath}`);
console.log(`Orders found: ${backup.tables.Orders?.length ?? 0}`);

if (!apply) {
  console.log("Dry run only. Run again with --apply to clear the backed-up test transactions.");
  await pool.end();
  process.exit(0);
}

const connection = await pool.getConnection();
try {
  await connection.beginTransaction();

  if (tables.has("Inventorys") && tables.has("Order_inventory_reservations")) {
    await connection.query(`
      UPDATE Inventorys i
      JOIN (
        SELECT inv_id,
          SUM(CASE WHEN status = 'reserved'
            THEN GREATEST(qty_reserved - qty_consumed, 0) ELSE 0 END) AS release_reserved,
          SUM(CASE WHEN status = 'consumed'
            THEN GREATEST(qty_consumed - qty_restocked, 0) ELSE 0 END) AS restore_on_hand
        FROM Order_inventory_reservations
        GROUP BY inv_id
      ) r ON r.inv_id = i.inv_id
      SET i.on_hand = i.on_hand + r.restore_on_hand,
          i.reserved_qty = GREATEST(i.reserved_qty - r.release_reserved, 0)
    `);
  }

  const deleteIfPresent = async (table, where = "") => {
    if (!tables.has(table)) return;
    await connection.query(`DELETE FROM \`${table}\`${where}`);
  };

  await deleteIfPresent("Notifications", " WHERE ref_type = 'ORDER'");
  await deleteIfPresent("Estimate_delivery_image");
  await deleteIfPresent("Estimate_delivery");
  await deleteIfPresent("Return_items");
  await deleteIfPresent("Returns");
  await deleteIfPresent("Refund_images");
  await deleteIfPresent("Refund_items");
  await deleteIfPresent("Refunds");
  await deleteIfPresent("Order_shipment_events");
  await deleteIfPresent("Order_shipment_items");
  await deleteIfPresent("Order_shipments");
  await deleteIfPresent("CouponRedemptions");

  if (tables.has("UserCoupons")) {
    await connection.query(`
      UPDATE UserCoupons
      SET status = 'claimed', used_at = NULL, or_id = NULL
      WHERE or_id IS NOT NULL
    `);
  }

  await deleteIfPresent("Payout_items");
  await deleteIfPresent("Payout_orders");
  await deleteIfPresent("Payout_history");
  await deleteIfPresent("Payouts");
  await deleteIfPresent("Payment_orders");
  await deleteIfPresent("Payments");
  await deleteIfPresent("Order_inventory_reservations");
  await deleteIfPresent("Order_items");
  await deleteIfPresent("Orders");
  await deleteIfPresent("Shipping_rates");
  await deleteIfPresent("Postcode_zone_rules");

  await connection.commit();
  console.log("Test order transactions cleared successfully.");
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  connection.release();
  await pool.end();
}
