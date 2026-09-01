import { pool } from "../dist/db/pool.js";

const [columns] = await pool.query("SHOW COLUMNS FROM Products");
console.log(`Products columns: ${columns.map((column) => column.Field).join(", ")}`);

const [stores] = await pool.query(`
  SELECT s.st_id, s.st_company_name, s.is_platform_store,
    COUNT(p.p_id) AS product_count
  FROM Store s
  LEFT JOIN Products p ON p.st_id = s.st_id
  GROUP BY s.st_id, s.st_company_name, s.is_platform_store
  ORDER BY s.is_platform_store DESC, s.st_id
`);
console.log("STORE_PRODUCT_COUNTS");
for (const store of stores) console.log(JSON.stringify(store));

const [orphans] = await pool.query(`
  SELECT COUNT(*) AS count
  FROM Products p
  LEFT JOIN Store s ON s.st_id = p.st_id
  WHERE s.st_id IS NULL
`);
console.log(`ORPHAN_PRODUCTS=${orphans[0]?.count ?? 0}`);

await pool.end();
