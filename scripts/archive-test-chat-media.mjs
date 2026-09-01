import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const backupArgument = process.argv.find((argument) => argument.endsWith(".json.gz"));
if (!backupArgument) throw new Error("Pass the chat-message backup .json.gz path.");

const apply = process.argv.includes("--apply");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const chatRoot = resolve(projectRoot, "public", "uploads", "chat") + sep;
const backupPath = resolve(projectRoot, backupArgument);
const payload = JSON.parse(gunzipSync(readFileSync(backupPath)));
const archiveDir = resolve(projectRoot, "backups", `chat-media-${Date.now()}`);

const sourcePaths = [...new Set(payload.messages
  .filter((message) => message.message_type === "image" && typeof message.body === "string")
  .map((message) => resolve(projectRoot, "public", message.body.replace(/^[/\\]+/, "")))
  .filter((path) => path.startsWith(chatRoot) && existsSync(path))
)];

console.log(`Local chat media found: ${sourcePaths.length}`);
if (!apply) {
  console.log("Dry run only. Run again with --apply to archive these files.");
  process.exit(0);
}

await mkdir(archiveDir, { recursive: true });
for (const sourcePath of sourcePaths) {
  await rename(sourcePath, resolve(archiveDir, basename(sourcePath)));
}
console.log(`Archived chat media: ${archiveDir}`);
