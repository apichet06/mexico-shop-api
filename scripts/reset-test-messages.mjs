import { mkdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../dist/db/pool.js";

const apply = process.argv.includes("--apply");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const backupDir = resolve(scriptDir, "..", "backups");
const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupPath = resolve(backupDir, `chat-messages-${timestamp}.json.gz`);

const [messages] = await pool.query("SELECT * FROM messages ORDER BY msg_id");
const [attachments] = await pool.query("SELECT * FROM message_attachments ORDER BY att_id");
const [participants] = await pool.query(`
  SELECT cp_id, conv_id, last_read_msg_id
  FROM Conversation_participants
  WHERE last_read_msg_id IS NOT NULL
  ORDER BY cp_id
`);
const [conversations] = await pool.query(`
  SELECT conv_id, created_at, updated_at
  FROM Conversations
  ORDER BY conv_id
`);

await mkdir(backupDir, { recursive: true });
await writeFile(backupPath, gzipSync(JSON.stringify({
  metadata: {
    created_at: new Date().toISOString(),
    purpose: "Backup before clearing test chat messages",
  },
  messages,
  message_attachments: attachments,
  participant_read_state: participants,
  conversation_timestamps: conversations,
})));

console.log(`Backup: ${backupPath}`);
console.log(`Messages found: ${messages.length}`);
console.log(`Attachments found: ${attachments.length}`);

if (!apply) {
  console.log("Dry run only. Run again with --apply to clear the backed-up test messages.");
  await pool.end();
  process.exit(0);
}

const connection = await pool.getConnection();
try {
  await connection.beginTransaction();
  await connection.query("DELETE FROM message_attachments");
  await connection.query("UPDATE Conversation_participants SET last_read_msg_id = NULL");
  await connection.query("DELETE FROM messages");
  await connection.query("UPDATE Conversations SET updated_at = created_at");
  await connection.commit();
  console.log("Test chat messages cleared successfully.");
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  connection.release();
  await pool.end();
}
