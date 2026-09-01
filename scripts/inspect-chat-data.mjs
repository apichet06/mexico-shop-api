import { pool } from "../dist/db/pool.js";

const [tables] = await pool.query(`
  SELECT TABLE_NAME AS table_name
  FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND (LOWER(TABLE_NAME) LIKE '%message%' OR LOWER(TABLE_NAME) LIKE '%conversation%')
  ORDER BY TABLE_NAME
`);

for (const table of tables) {
  const name = String(table.table_name).replace(/[^A-Za-z0-9_]/g, "");
  const [rows] = await pool.query(`SELECT COUNT(*) AS count FROM \`${name}\``);
  console.log(`${name}=${rows[0]?.count ?? 0}`);
}

const [foreignKeys] = await pool.query(`
  SELECT TABLE_NAME AS child_table, COLUMN_NAME AS child_column,
    REFERENCED_TABLE_NAME AS parent_table, REFERENCED_COLUMN_NAME AS parent_column
  FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND REFERENCED_TABLE_NAME IS NOT NULL
    AND (LOWER(TABLE_NAME) LIKE '%message%'
      OR LOWER(REFERENCED_TABLE_NAME) LIKE '%message%'
      OR LOWER(TABLE_NAME) LIKE '%conversation%'
      OR LOWER(REFERENCED_TABLE_NAME) LIKE '%conversation%')
  ORDER BY TABLE_NAME, COLUMN_NAME
`);
console.log("FOREIGN_KEYS");
for (const key of foreignKeys) console.log(JSON.stringify(key));

console.log("TABLE_COLUMNS");
for (const tableName of ["messages", "message_attachments", "Conversation_participants", "Conversations"]) {
  const [columns] = await pool.query(`SHOW COLUMNS FROM \`${tableName}\``);
  console.log(`${tableName}: ${columns.map((column) => `${column.Field}:${column.Null}`).join(", ")}`);
}

await pool.end();
