import "dotenv/config";
import mysql from "mysql2/promise";

const targetTables = ["Subdistricts", "Districts", "Provinces"];
const connection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

try {
  const [foreignKeys] = await connection.query(
    `SELECT DISTINCT TABLE_NAME, CONSTRAINT_NAME
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND REFERENCED_TABLE_NAME IN (?, ?, ?)
      ORDER BY TABLE_NAME, CONSTRAINT_NAME`,
    targetTables,
  );

  for (const { TABLE_NAME: table, CONSTRAINT_NAME: constraint } of foreignKeys) {
    if (!/^[A-Za-z0-9_]+$/.test(table) || !/^[A-Za-z0-9_]+$/.test(constraint)) {
      throw new Error("Unsafe database identifier detected; migration aborted");
    }
    await connection.query(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${constraint}\``);
    console.log(`Dropped foreign key ${table}.${constraint}`);
  }

  for (const table of targetTables) {
    await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
    console.log(`Dropped table ${table}`);
  }

  const [remaining] = await connection.query(
    `SELECT TABLE_NAME
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (?, ?, ?)`,
    targetTables,
  );
  if (remaining.length > 0) {
    throw new Error(`Migration verification failed: ${remaining.map((row) => row.TABLE_NAME).join(", ")}`);
  }
  console.log(`Verified ${process.env.DB_NAME}: Thai address tables are absent`);
} finally {
  await connection.end();
}
