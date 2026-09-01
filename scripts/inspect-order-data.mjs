import { pool } from "../dist/db/pool.js";

const [tables] = await pool.query(`
  SELECT TABLE_NAME AS table_name
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND (
      TABLE_NAME LIKE '%Order%'
      OR TABLE_NAME LIKE '%Payment%'
      OR TABLE_NAME LIKE '%Refund%'
      OR TABLE_NAME LIKE '%shipment%'
      OR TABLE_NAME LIKE '%reservation%'
      OR TABLE_NAME LIKE '%Coupon%'
      OR TABLE_NAME LIKE '%Payout%'
      OR TABLE_NAME LIKE '%Return%'
      OR TABLE_NAME LIKE '%Estimate%'
      OR TABLE_NAME LIKE '%Webhook%'
      OR TABLE_NAME LIKE '%Transaction%'
    )
  ORDER BY TABLE_NAME
`);

for (const table of tables) {
  const safeName = String(table.table_name).replace(/[^A-Za-z0-9_]/g, "");
  const [rows] = await pool.query(`SELECT COUNT(*) AS count FROM \`${safeName}\``);
  console.log(`${safeName}=${rows[0]?.count ?? 0}`);
}

const [foreignKeys] = await pool.query(`
  SELECT
    TABLE_NAME AS child_table,
    COLUMN_NAME AS child_column,
    REFERENCED_TABLE_NAME AS parent_table,
    REFERENCED_COLUMN_NAME AS parent_column
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND REFERENCED_TABLE_NAME IS NOT NULL
    AND (
      TABLE_NAME LIKE '%Order%'
      OR REFERENCED_TABLE_NAME LIKE '%Order%'
      OR TABLE_NAME LIKE '%Payment%'
      OR TABLE_NAME LIKE '%Refund%'
      OR TABLE_NAME LIKE '%shipment%'
    )
  ORDER BY TABLE_NAME, COLUMN_NAME
`);

console.log("FOREIGN_KEYS");
for (const foreignKey of foreignKeys) console.log(JSON.stringify(foreignKey));

const [transactionColumns] = await pool.query(`
  SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND COLUMN_NAME IN ('or_id', 'oi_id', 'os_id', 'pay_id', 'refund_id', 'payout_id', 'cart_id')
  ORDER BY TABLE_NAME, ORDINAL_POSITION
`);
console.log("TRANSACTION_COLUMNS");
for (const column of transactionColumns) console.log(JSON.stringify(column));

const detailTables = [
  "Inventorys",
  "Order_inventory_reservations",
  "UserCoupons",
  "Payouts",
  "Payout_items",
  "Payout_orders",
  "Returns",
  "Return_items",
  "Notifications",
  "Shipping_carriers",
  "Shipping_rates",
  "Postcode_zone_rules",
];

const [availableTables] = await pool.query(`
  SELECT TABLE_NAME AS table_name
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
`);
const available = new Set(availableTables.map((row) => row.table_name));

console.log("TABLE_COLUMNS");
for (const tableName of detailTables.filter((name) => available.has(name))) {
  const [columns] = await pool.query(`SHOW COLUMNS FROM \`${tableName}\``);
  console.log(`${tableName}: ${columns.map((column) => column.Field).join(", ")}`);
}

if (available.has("Order_inventory_reservations")) {
  const [statuses] = await pool.query(`
    SELECT status, COUNT(*) AS count,
      COALESCE(SUM(qty_reserved), 0) AS qty_reserved,
      COALESCE(SUM(qty_consumed), 0) AS qty_consumed,
      COALESCE(SUM(qty_restocked), 0) AS qty_restocked
    FROM Order_inventory_reservations
    GROUP BY status
  `);
  console.log("RESERVATION_STATUS");
  for (const status of statuses) console.log(JSON.stringify(status));
}

if (available.has("Shipping_carriers")) {
  const [carriers] = await pool.query(`
    SELECT sc_id, sc_code, sc_name,
      provider_code,
      is_active
    FROM Shipping_carriers
    ORDER BY sc_id
  `);
  console.log("SHIPPING_CARRIERS");
  for (const carrier of carriers) console.log(JSON.stringify(carrier));
}

const preservedTables = ["Products", "ProductVariants", "Users", "Store", "Addresses", "Inventorys", "Coupon", "Payout_settings"];
console.log("PRESERVED_COUNTS");
for (const tableName of preservedTables.filter((name) => available.has(name))) {
  const [rows] = await pool.query(`SELECT COUNT(*) AS count FROM \`${tableName}\``);
  console.log(`${tableName}=${rows[0]?.count ?? 0}`);
}
if (available.has("UserCoupons")) {
  const [userCouponStatuses] = await pool.query(`
    SELECT status, COUNT(*) AS count, SUM(or_id IS NOT NULL) AS linked_orders
    FROM UserCoupons GROUP BY status
  `);
  console.log("USER_COUPON_STATUS");
  for (const status of userCouponStatuses) console.log(JSON.stringify(status));
}
if (available.has("Notifications")) {
  const [notificationRefs] = await pool.query(`
    SELECT ref_type, COUNT(*) AS count FROM Notifications GROUP BY ref_type
  `);
  console.log("NOTIFICATION_REFS");
  for (const ref of notificationRefs) console.log(JSON.stringify(ref));
}
await pool.end();
