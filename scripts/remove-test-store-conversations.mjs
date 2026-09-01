import { pool } from "../dist/db/pool.js";

const apply = process.argv.includes("--apply");
const storeNames = ["Football Fanatic", "SHOP LOCAL"];

const [rows] = await pool.query(`
  SELECT c.conv_id, c.channel, c.st_id, s.st_company_name,
    COUNT(DISTINCT cp.cp_id) AS participant_count,
    COUNT(DISTINCT m.msg_id) AS message_count
  FROM Conversations c
  INNER JOIN Store s ON s.st_id = c.st_id
  LEFT JOIN Conversation_participants cp ON cp.conv_id = c.conv_id
  LEFT JOIN messages m ON m.conv_id = c.conv_id
  WHERE s.st_company_name IN (?, ?)
  GROUP BY c.conv_id, c.channel, c.st_id, s.st_company_name
  ORDER BY s.st_company_name, c.conv_id
`, storeNames);

console.log(JSON.stringify(rows));
const conversationIds = rows.map((row) => Number(row.conv_id));
if (conversationIds.length === 0) {
  console.log("No matching conversations found.");
  await pool.end();
  process.exit(0);
}
if (!apply) {
  console.log(`Dry run only. Matching conversations: ${conversationIds.length}`);
  await pool.end();
  process.exit(0);
}

const connection = await pool.getConnection();
try {
  await connection.beginTransaction();
  await connection.query(`
    DELETE ma FROM message_attachments ma
    INNER JOIN messages m ON m.msg_id = ma.msg_id
    WHERE m.conv_id IN (?)
  `, [conversationIds]);
  await connection.query("DELETE FROM messages WHERE conv_id IN (?)", [conversationIds]);
  await connection.query("DELETE FROM Conversation_links WHERE conv_id IN (?)", [conversationIds]);
  await connection.query("DELETE FROM Conversation_participants WHERE conv_id IN (?)", [conversationIds]);
  await connection.query("DELETE FROM Conversations WHERE conv_id IN (?)", [conversationIds]);
  await connection.commit();
  console.log(`Removed conversations: ${conversationIds.length}`);
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  connection.release();
  await pool.end();
}
