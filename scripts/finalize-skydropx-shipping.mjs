import { pool } from "../dist/db/pool.js";

async function tableExists(tableName) {
  const [rows] = await pool.query(`
    SELECT 1
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
    LIMIT 1
  `, [tableName]);
  return rows.length > 0;
}

async function columnExists(tableName, columnName) {
  const [rows] = await pool.query(`
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
    LIMIT 1
  `, [tableName, columnName]);
  return rows.length > 0;
}

if (!(await columnExists("Shipping_carriers", "provider_code"))) {
  await pool.query("ALTER TABLE Shipping_carriers ADD COLUMN provider_code VARCHAR(80) NULL AFTER sc_name");
}

await pool.query(`
  UPDATE Shipping_carriers
  SET provider_code = LOWER(TRIM(provider_code))
  WHERE provider_code IS NOT NULL
`);
const [removed] = await pool.query(`
  DELETE FROM Shipping_carriers
  WHERE provider_code IS NULL OR TRIM(provider_code) = ''
`);
console.log(`Removed carriers without provider_code: ${removed.affectedRows}`);

await pool.query("ALTER TABLE Shipping_carriers MODIFY provider_code VARCHAR(80) NOT NULL");

if (await columnExists("Shipping_carriers", "shippop_courier_code")) {
  await pool.query("ALTER TABLE Shipping_carriers DROP COLUMN shippop_courier_code");
  console.log("Removed legacy carrier-code column.");
}
if (await columnExists("Orders", "shipping_zone_code")) {
  await pool.query("ALTER TABLE Orders DROP COLUMN shipping_zone_code");
  console.log("Removed order shipping-zone snapshot column.");
}
for (const table of ["Shipping_rates", "Postcode_zone_rules"]) {
  if (await tableExists(table)) {
    await pool.query(`DROP TABLE \`${table}\``);
    console.log(`Removed unused table: ${table}`);
  }
}

await pool.end();
console.log("Skydropx-only shipping schema is ready.");
