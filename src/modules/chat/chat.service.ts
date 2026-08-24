import { pool } from "../../db/pool.js";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { ConversationDTO, ConversationWithBuyerDTO, ConversationWithStoreDTO, MessageDTO, MessageType } from "./chat.type.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import { getIO } from "../../socket/socket.js";
import { fileUploadImage } from "../../shared/middlewares/fileUploadImage.js";

// ── Auto-reply ─────────────────────────────────────────────────────────────
// ถ้า admin ไม่ตอบภายใน AUTO_REPLY_DELAY_MS หลัง buyer ส่งข้อความ
// ระบบจะส่งข้อความ bot อัตโนมัติเพื่อแจ้ง buyer ว่าเจ้าหน้าที่ติดภารกิจ

// เก็บ timer ของแต่ละห้องแชท (conv_id → timer handle)
const autoReplyTimers = new Map<number, NodeJS.Timeout>();

// แก้ตรงนี้เพื่อปรับเวลาและข้อความ
const AUTO_REPLY_DELAY_MS = 60_000; // 1 นาที
const AUTO_REPLY_MESSAGE =
    "ขออภัยในความไม่สะดวก ขณะนี้เจ้าหน้าที่ติดภารกิจและไม่สามารถตอบกลับได้ในขณะนี้\n" +
    "เมื่อเจ้าหน้าที่พร้อมแล้วจะรีบตอบกลับคุณโดยเร็วที่สุด ขอบคุณที่ติดต่อมาค่ะ";

// เรียกเมื่อ admin ส่งข้อความ เพื่อยกเลิก timer ที่รออยู่
function cancelAutoReply(conv_id: number): void {
    const existing = autoReplyTimers.get(conv_id);
    if (existing) {
        clearTimeout(existing);
        autoReplyTimers.delete(conv_id);
    }
}

// เรียกเมื่อ buyer ส่งข้อความ — reset timer ทุกครั้งที่ buyer ส่งใหม่
function scheduleAutoReply(conv_id: number): void {
    cancelAutoReply(conv_id); // reset ถ้า timer เดิมยังค้างอยู่
    const timer = setTimeout(() => {
        autoReplyTimers.delete(conv_id);
        sendAutoReply(conv_id).catch(() => { /* no-op */ });
    }, AUTO_REPLY_DELAY_MS);
    autoReplyTimers.set(conv_id, timer);
}

// ตรวจสอบอีกครั้งก่อนส่ง เผื่อ admin ตอบมาพอดีช่วงที่ timer กำลังจะ fire (race condition)
async function sendAutoReply(conv_id: number): Promise<void> {
    const [checkRows] = await pool.query<(RowDataPacket & { has_reply: number })[]>(
        `SELECT EXISTS(
            SELECT 1 FROM messages
            WHERE conv_id = ?
              AND sender_type IN ('employee', 'bot')
              AND deleted_at IS NULL
              AND created_at > (
                  SELECT MAX(created_at) FROM messages
                  WHERE conv_id = ? AND sender_type = 'user' AND deleted_at IS NULL
              )
        ) AS has_reply`,
        [conv_id, conv_id]
    );
    if (checkRows[0]?.has_reply) return; // admin ตอบแล้ว ไม่ต้องส่ง bot

    const [convRows] = await pool.query<(RowDataPacket & { st_id: number; channel: string })[]>(
        `SELECT st_id, channel FROM Conversations WHERE conv_id = ?`,
        [conv_id]
    );
    if (!convRows[0] || convRows[0].channel === 'support') return; // ไม่ส่งในห้อง store-to-store

    const stId = convRows[0].st_id;
    const message = await insertBotMessage(conv_id, AUTO_REPLY_MESSAGE, 'text');

    // ดึงรายชื่อ buyer ในห้องนี้เพื่อ emit ไปที่ USER room (อัปเดต unread badge storefront)
    const [participantUsers] = await pool.query<(RowDataPacket & { actor_id: number })[]>(
        `SELECT actor_id FROM Conversation_participants WHERE conv_id = ? AND actor_type = 'user'`,
        [conv_id]
    );

    try {
        const io = getIO();
        io.to(`CONV_${conv_id}`).emit('new_message', message);
        io.to(`STORE_${stId}`).emit('chat:new_message', { conv_id, message });
        participantUsers.forEach(user => {
            io.to(`USER_${user.actor_id}`).emit('chat:new_message', { conv_id, message });
        });
    } catch { /* no-op */ }

    await pool.query(`UPDATE Conversations SET updated_at = NOW() WHERE conv_id = ?`, [conv_id]);
}

// ── Buyer ──────────────────────────────────────────────────────────────────

export async function getOrCreateConversation(
    userId: number,
    stId?: number
): Promise<ConversationWithStoreDTO> {
    const targetStoreId = stId || await getPlatformStoreId();
    const conn = await pool.getConnection();
    try {
        const [existing] = await conn.query<(RowDataPacket & { conv_id: number })[]>(
            `SELECT c.conv_id FROM Conversations c
             INNER JOIN Conversation_participants cp ON cp.conv_id = c.conv_id
             WHERE cp.actor_type = 'user' AND cp.actor_id = ? AND c.st_id = ? AND c.status = 'open'
             LIMIT 1`,
            [userId, targetStoreId]
        );

        if (existing[0]) {
            const conversation = await getBuyerConversationById(existing[0].conv_id, userId, conn);
            if (conversation) return conversation;
        }

        await conn.beginTransaction();

        const [convResult] = await conn.query<ResultSetHeader>(
            `INSERT INTO Conversations (channel, st_id, status, created_at, updated_at)
             VALUES ('live_chat', ?, 'open', NOW(), NOW())`,
            [targetStoreId]
        );
        const conv_id = convResult.insertId;

        await conn.query(
            `INSERT INTO Conversation_participants (actor_type, actor_id, role_in_conv, joined_at, conv_id)
             VALUES ('user', ?, 'customer', NOW(), ?)`,
            [userId, conv_id]
        );

        await conn.commit();

        const newConv = await getBuyerConversationById(conv_id, userId, conn);

        if (!newConv) throw new ApiError(500, "สร้างห้องแชทไม่สำเร็จ");
        return newConv;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function getPlatformStoreId(): Promise<number> {
    const [rows] = await pool.query<(RowDataPacket & { st_id: number })[]>(
        `SELECT st_id FROM Store WHERE is_platform_store = 1 AND st_status = 'ACTIVE' ORDER BY st_id ASC LIMIT 1`
    );

    const platformStoreId = rows[0]?.st_id;
    if (!platformStoreId) throw new ApiError(404, "ไม่พบร้าน Platform สำหรับห้องแชท");

    return platformStoreId;
}

export async function listConversations(userId: number): Promise<ConversationWithStoreDTO[]> {
    await ensurePlatformConversationForUser(userId);

    const [rows] = await pool.query<(RowDataPacket & ConversationWithStoreDTO)[]>(
        `${buyerConversationSelectSql()}
         FROM Conversations c
         INNER JOIN Conversation_participants cp
           ON cp.conv_id = c.conv_id
          AND cp.actor_type = 'user'
          AND cp.actor_id = ?
         LEFT JOIN Store s ON s.st_id = c.st_id
         WHERE c.status = 'open'
         ORDER BY COALESCE(last_message_at, c.updated_at, c.created_at) DESC`,
        [userId]
    );

    return rows;
}

async function ensurePlatformConversationForUser(userId: number): Promise<void> {
    try {
        await getOrCreateConversation(userId);
    } catch (err) {
        if (err instanceof ApiError && err.status === 404) return;
        throw err;
    }
}

function buyerConversationSelectSql(): string {
    return `SELECT
            c.conv_id, c.channel, c.subject, c.status, c.st_id, c.created_at, c.updated_at,
            COALESCE(NULLIF(s.st_company_name, ''), CONCAT('Store #', c.st_id)) AS store_name,
            s.st_email AS store_email,
            s.st_image AS store_image,
            (
                SELECT m.body FROM messages m
                WHERE m.conv_id = c.conv_id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message,
            (
                SELECT m.message_type FROM messages m
                WHERE m.conv_id = c.conv_id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message_type,
            (
                SELECT m.created_at FROM messages m
                WHERE m.conv_id = c.conv_id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message_at,
            (
                SELECT COUNT(*) FROM messages m
                WHERE m.conv_id = c.conv_id
                  AND m.sender_type = 'employee'
                  AND m.deleted_at IS NULL
                  AND m.msg_id > IFNULL(cp.last_read_msg_id, 0)
            ) AS unread_count`;
}

async function getBuyerConversationById(
    convId: number,
    userId: number,
    executor: Pool | PoolConnection
): Promise<ConversationWithStoreDTO | null> {
    const [rows] = await executor.query<(RowDataPacket & ConversationWithStoreDTO)[]>(
        `${buyerConversationSelectSql()}
         FROM Conversations c
         INNER JOIN Conversation_participants cp
           ON cp.conv_id = c.conv_id
          AND cp.actor_type = 'user'
          AND cp.actor_id = ?
         LEFT JOIN Store s ON s.st_id = c.st_id
         WHERE c.conv_id = ? AND c.status = 'open'
         LIMIT 1`,
        [userId, convId]
    );

    return rows[0] ?? null;
}

async function isPlatformStore(storeId: number): Promise<boolean> {
    const [rows] = await pool.query<(RowDataPacket & { is_platform_store: boolean | 0 | 1 | "0" | "1" })[]>(
        `SELECT is_platform_store FROM Store WHERE st_id = ? LIMIT 1`,
        [storeId]
    );

    const value = rows[0]?.is_platform_store;
    return value === true || value === 1 || value === "1";
}

async function getStoreContact(storeId: number): Promise<{ name: string; email: string | null; image: string | null }> {
    const [rows] = await pool.query<(RowDataPacket & { st_company_name: string; st_email: string | null; st_image: string | null })[]>(
        `SELECT st_company_name, st_email, st_image FROM Store WHERE st_id = ? LIMIT 1`,
        [storeId]
    );

    const store = rows[0];
    return {
        name: store?.st_company_name ?? "Platform",
        email: store?.st_email ?? null,
        image: store?.st_image ?? null,
    };
}

async function canAdminAccessConversation(convId: number, storeId: number): Promise<boolean> {
    const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT c.conv_id
         FROM Conversations c
         WHERE c.conv_id = ?
           AND (
                -- ห้อง buyer: ร้านเจ้าของสินค้า/platform ดูได้จาก c.st_id
                (c.channel <> 'support' AND c.st_id = ?)
                OR
                -- ห้องร้านต่อร้าน: ร้านปลายทางดูได้จาก c.st_id, ร้านต้นทางดูได้จาก participant store
                (c.channel = 'support' AND (
                    c.st_id = ?
                    OR EXISTS (
                        SELECT 1 FROM Conversation_participants cp_store
                        WHERE cp_store.conv_id = c.conv_id
                          AND cp_store.actor_type = 'store'
                          AND cp_store.actor_id = ?
                    )
                ))
           )
         LIMIT 1`,
        [convId, storeId, storeId, storeId]
    );

    return Boolean(rows[0]);
}

function selectMessageSql(): string {
    return `SELECT
                m.*,
                e.st_id AS sender_store_id,
                COALESCE(e.e_firstname, s.st_company_name) AS sender_name
            FROM messages m
            LEFT JOIN Employees e ON e.e_id = m.sender_id AND m.sender_type = 'employee'
            LEFT JOIN Store s ON s.st_id = e.st_id`;
}

async function canStoreChatWithTarget(storeId: number, targetStoreId: number): Promise<boolean> {
    if (storeId === targetStoreId) return false;
    const [rows] = await pool.query<(RowDataPacket & { is_platform_store: boolean | 0 | 1 | "0" | "1" })[]>(
        `SELECT is_platform_store FROM Store WHERE st_id IN (?, ?)`,
        [storeId, targetStoreId]
    );

    if (rows.length < 2) return false;

    const currentIsPlatform = await isPlatformStore(storeId);
    const targetIsPlatform = await isPlatformStore(targetStoreId);
    return currentIsPlatform !== targetIsPlatform;
}

export async function adminGetOrCreateStoreConversation(storeId: number, targetStoreId: number): Promise<ConversationDTO> {
    if (!await canStoreChatWithTarget(storeId, targetStoreId)) {
        throw new ApiError(403, "ไม่มีสิทธิ์เข้าถึงร้านค้านี้");
    }

    const conn = await pool.getConnection();
    try {
        // ห้องร้านต่อร้านอิง Store จริง: c.st_id คือร้านปลายทาง, participant store คือร้านต้นทาง
        const [existing] = await conn.query<(RowDataPacket & ConversationDTO)[]>(
            `SELECT c.* FROM Conversations c
             INNER JOIN Conversation_participants cp
              ON cp.conv_id = c.conv_id
             AND cp.actor_type = 'store'
             AND cp.actor_id = ?
             WHERE c.st_id = ? AND c.channel = 'support'
             ORDER BY c.updated_at DESC, c.conv_id DESC
             LIMIT 1`,
            [storeId, targetStoreId]
        );

        if (existing[0]) return existing[0];

        const [reverseExisting] = await conn.query<(RowDataPacket & ConversationDTO)[]>(
            `SELECT c.* FROM Conversations c
             INNER JOIN Conversation_participants cp
               ON cp.conv_id = c.conv_id
              AND cp.actor_type = 'store'
              AND cp.actor_id = ?
             WHERE c.st_id = ? AND c.channel = 'support'
             ORDER BY c.updated_at DESC, c.conv_id DESC
             LIMIT 1`,
            [targetStoreId, storeId]
        );

        if (reverseExisting[0]) {
            // ถ้ามีห้องคู่ร้านนี้อยู่แล้วในทิศกลับ ให้ใช้ห้องเดิม
            // ร้านปลายทางมีสิทธิ์จาก Conversations.st_id อยู่แล้ว จึงไม่ต้องเพิ่ม participant ซ้ำ
            return reverseExisting[0];
        }

        await conn.beginTransaction();

        const [convResult] = await conn.query<ResultSetHeader>(
            `INSERT INTO Conversations (channel, st_id, subject, status, created_at, updated_at)
             VALUES ('support', ?, 'ติดต่อร้านค้า', 'open', NOW(), NOW())`,
            [targetStoreId]
        );
        const conv_id = convResult.insertId;

        await conn.query(
            `INSERT INTO Conversation_participants (actor_type, actor_id, role_in_conv, joined_at, conv_id)
             VALUES ('store', ?, 'customer', NOW(), ?)`,
            [storeId, conv_id]
        );

        await conn.commit();

        const [newConv] = await conn.query<(RowDataPacket & ConversationDTO)[]>(
            `SELECT * FROM Conversations WHERE conv_id = ?`,
            [conv_id]
        );

        return newConv[0]!;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function getMessages(conv_id: number, userId: number): Promise<MessageDTO[]> {
    const [participants] = await pool.query<RowDataPacket[]>(
        `SELECT cp_id FROM Conversation_participants
         WHERE conv_id = ? AND actor_type = 'user' AND actor_id = ?`,
        [conv_id, userId]
    );
    if (!participants[0]) throw new ApiError(403, "ไม่มีสิทธิ์เข้าถึงการสนทนานี้");

    const [rows] = await pool.query<(RowDataPacket & MessageDTO)[]>(
        `${selectMessageSql()} WHERE m.conv_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at ASC`,
        [conv_id]
    );
    return rows;
}

export async function markAsRead(conv_id: number, userId: number): Promise<void> {
    const [participants] = await pool.query<RowDataPacket[]>(
        `SELECT cp_id FROM Conversation_participants
         WHERE conv_id = ? AND actor_type = 'user' AND actor_id = ?`,
        [conv_id, userId]
    );
    if (!participants[0]) throw new ApiError(403, "ไม่มีสิทธิ์เข้าถึงการสนทนานี้");

    const [lastMsg] = await pool.query<(RowDataPacket & { max_id: number | null })[]>(
        `SELECT MAX(msg_id) AS max_id FROM messages WHERE conv_id = ? AND deleted_at IS NULL`,
        [conv_id]
    );
    const lastMsgId = lastMsg[0]?.max_id ?? 0;
    if (!lastMsgId) return;

    await pool.query(
        `UPDATE Conversation_participants
         SET last_read_msg_id = ?
         WHERE conv_id = ? AND actor_type = 'user' AND actor_id = ?`,
        [lastMsgId, conv_id, userId]
    );
}

export async function sendMessage(
    conv_id: number,
    userId: number,
    body: string,
    message_type: string = 'text'
): Promise<MessageDTO> {
    const [participants] = await pool.query<RowDataPacket[]>(
        `SELECT cp_id FROM Conversation_participants
         WHERE conv_id = ? AND actor_type = 'user' AND actor_id = ?`,
        [conv_id, userId]
    );
    if (!participants[0]) throw new ApiError(403, "ไม่มีสิทธิ์เข้าถึงการสนทนานี้");

    const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO messages (conv_id, sender_type, sender_id, message_type, body, created_at)
         VALUES (?, 'user', ?, ?, ?, NOW())`,
        [conv_id, userId, message_type, body]
    );

    const [rows] = await pool.query<(RowDataPacket & MessageDTO)[]>(
        `${selectMessageSql()} WHERE m.msg_id = ?`,
        [result.insertId]
    );

    const message = rows[0]!;

    // notify conversation room + store room for admin
    const [convRows] = await pool.query<(RowDataPacket & { st_id: number })[]>(
        `SELECT st_id FROM Conversations WHERE conv_id = ?`,
        [conv_id]
    );
    const stId = convRows[0]?.st_id ?? 1;

    try {
        const io = getIO();
        io.to(`CONV_${conv_id}`).emit('new_message', message);
        io.to(`STORE_${stId}`).emit('chat:new_message', { conv_id, message });
    } catch { /* no-op */ }

    scheduleAutoReply(conv_id);
    await pool.query(`UPDATE Conversations SET updated_at = NOW() WHERE conv_id = ?`, [conv_id]);

    return message;
}

async function insertUserMessage(
    conv_id: number,
    userId: number,
    body: string,
    message_type: string = 'text'
): Promise<MessageDTO> {
    const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO messages (conv_id, sender_type, sender_id, message_type, body, created_at)
         VALUES (?, 'user', ?, ?, ?, NOW())`,
        [conv_id, userId, message_type, body]
    );

    const [rows] = await pool.query<(RowDataPacket & MessageDTO)[]>(
        `${selectMessageSql()} WHERE m.msg_id = ?`,
        [result.insertId]
    );

    return rows[0]!;
}

async function insertBotMessage(
    conv_id: number,
    body: string,
    message_type: string = 'text'
): Promise<MessageDTO> {
    const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO messages (conv_id, sender_type, sender_id, message_type, body, created_at)
         VALUES (?, 'bot', NULL, ?, ?, NOW())`,
        [conv_id, message_type, body]
    );

    const [rows] = await pool.query<(RowDataPacket & MessageDTO)[]>(
        `${selectMessageSql()} WHERE m.msg_id = ?`,
        [result.insertId]
    );

    return rows[0]!;
}

async function emitBuyerMessage(conv_id: number, message: MessageDTO) {
    const [convRows] = await pool.query<(RowDataPacket & { st_id: number })[]>(
        `SELECT st_id FROM Conversations WHERE conv_id = ?`,
        [conv_id]
    );
    const stId = convRows[0]?.st_id ?? 1;

    try {
        const io = getIO();
        io.to(`CONV_${conv_id}`).emit('new_message', message);
        io.to(`STORE_${stId}`).emit('chat:new_message', { conv_id, message });
    } catch { /* no-op */ }

    await pool.query(`UPDATE Conversations SET updated_at = NOW() WHERE conv_id = ?`, [conv_id]);
}

export async function sendImageMessages(
    conv_id: number,
    userId: number,
    files: Express.Multer.File[]
): Promise<MessageDTO[]> {
    const [participants] = await pool.query<RowDataPacket[]>(
        `SELECT cp_id FROM Conversation_participants
         WHERE conv_id = ? AND actor_type = 'user' AND actor_id = ?`,
        [conv_id, userId]
    );
    if (!participants[0]) throw new ApiError(403, "ไม่มีสิทธิ์เข้าถึงการสนทนานี้");
    if (!files.length) throw new ApiError(400, "กรุณาแนบรูปภาพ");

    const messages: MessageDTO[] = [];
    for (const [index, file] of files.entries()) {
        const imagePath = await fileUploadImage(file, `chat_${conv_id}_${Date.now()}_${index}`, "chat");
        const message = await insertUserMessage(conv_id, userId, imagePath, 'image');
        await emitBuyerMessage(conv_id, message);
        messages.push(message);
    }

    scheduleAutoReply(conv_id);
    return messages;
}

export async function postRefundContextToConversation(options: {
    userId: number;
    storeId: number;
    orderNo: string;
    reason: string;
    amount: number;
    returnTracking?: string | null;
    imageUrls?: string[];
}): Promise<void> {
    const conv = await getOrCreateConversation(options.userId, options.storeId);
    const lines = [
        "ลูกค้าส่งคำขอคืนสินค้า/คืนเงิน",
        `Order: ${options.orderNo}`,
        `ยอดที่ขอคืน: ${Number(options.amount).toLocaleString("th-TH", { style: "currency", currency: "THB" })}`,
        options.returnTracking ? `Tracking คืนสินค้า: ${options.returnTracking}` : null,
        `เหตุผล: ${options.reason}`,
    ].filter(Boolean);

    const summary = await insertUserMessage(conv.conv_id, options.userId, lines.join("\n"), 'text');
    await emitBuyerMessage(conv.conv_id, summary);

    for (const imageUrl of options.imageUrls ?? []) {
        const image = await insertUserMessage(conv.conv_id, options.userId, imageUrl, 'image');
        await emitBuyerMessage(conv.conv_id, image);
    }
}

// หา/สร้างห้องแชทกับ buyer เฉพาะราย
// ใช้โดย backoffice เพื่อส่งแจ้งเตือนอัตโนมัติเข้าห้องแชทของ buyer หลังดำเนินการ order
// (เช่น อนุมัติ/ปฏิเสธคืนเงิน, ยืนยันรับสินค้าคืน)
export async function adminGetOrCreateBuyerConversation(storeId: number, buyerId: number): Promise<ConversationDTO> {
    const conn = await pool.getConnection();
    try {
        // ลองหาห้อง open ที่มีอยู่ก่อน ไม่ต้องสร้างซ้ำถ้า buyer เคยคุยกับร้านนี้แล้ว
        const [existing] = await conn.query<(RowDataPacket & ConversationDTO)[]>(
            `SELECT c.* FROM Conversations c
             INNER JOIN Conversation_participants cp ON cp.conv_id = c.conv_id
             WHERE cp.actor_type = 'user' AND cp.actor_id = ? AND c.st_id = ? AND c.status = 'open'
             LIMIT 1`,
            [buyerId, storeId]
        );

        if (existing[0]) return existing[0];

        // ไม่มีห้องเดิม — สร้างใหม่พร้อม participant buyer
        await conn.beginTransaction();

        const [convResult] = await conn.query<ResultSetHeader>(
            `INSERT INTO Conversations (channel, st_id, status, created_at, updated_at)
             VALUES ('live_chat', ?, 'open', NOW(), NOW())`,
            [storeId]
        );
        const conv_id = convResult.insertId;

        await conn.query(
            `INSERT INTO Conversation_participants (actor_type, actor_id, role_in_conv, joined_at, conv_id)
             VALUES ('user', ?, 'customer', NOW(), ?)`,
            [buyerId, conv_id]
        );

        await conn.commit();

        const [newConv] = await conn.query<(RowDataPacket & ConversationDTO)[]>(
            `SELECT * FROM Conversations WHERE conv_id = ?`,
            [conv_id]
        );

        return newConv[0]!;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// ── Admin ──────────────────────────────────────────────────────────────────

export async function adminGetConversations(storeId: number, empId: number): Promise<ConversationWithBuyerDTO[]> {
    const platformStore = await isPlatformStore(storeId);
    const [buyerRows] = await pool.query<(RowDataPacket & ConversationWithBuyerDTO)[]>(
        `SELECT
            c.conv_id, c.channel, c.subject, c.status, c.st_id, c.created_at, c.updated_at,
            COALESCE(u.u_id, cp_user.actor_id) AS buyer_id,
            COALESCE(NULLIF(u.u_username, ''), CONCAT('Buyer #', cp_user.actor_id)) AS buyer_username,
            u.u_email AS buyer_email,
            u.u_avatar AS buyer_avatar,
            NULL AS target_store_id,
            0 AS is_contact,
            (
                SELECT m.body FROM messages m
                WHERE m.conv_id = c.conv_id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message,
            (
                SELECT m.message_type FROM messages m
                WHERE m.conv_id = c.conv_id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message_type,
            (
                SELECT m.created_at FROM messages m
                WHERE m.conv_id = c.conv_id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message_at,
            (
                SELECT COUNT(*) FROM messages m
                WHERE m.conv_id = c.conv_id
                  AND m.sender_type = 'user'
                  AND m.deleted_at IS NULL
                  AND m.msg_id > IFNULL(
                      (SELECT cp2.last_read_msg_id FROM Conversation_participants cp2
                       WHERE cp2.conv_id = c.conv_id AND cp2.actor_type = 'employee' AND cp2.actor_id = ? LIMIT 1),
                      0
                  )
            ) AS unread_count
         FROM Conversations c
         INNER JOIN Conversation_participants cp_user ON cp_user.conv_id = c.conv_id AND cp_user.actor_type = 'user'
         LEFT JOIN Users u ON u.u_id = cp_user.actor_id
         WHERE c.channel <> 'support'
           AND c.st_id = ?
         ORDER BY c.updated_at DESC`,
        [empId, storeId]
    );

    const [supportRowsRaw] = await pool.query<(RowDataPacket & {
        conv_id: number;
        channel: "support";
        subject: string | null;
        status: "open" | "closed" | "resolved";
        st_id: number;
        created_at: Date;
        updated_at: Date;
        source_store_id: number;
        source_store_name: string;
        source_store_email: string | null;
        source_store_image: string | null;
        target_store_id: number;
        target_store_name: string;
        target_store_email: string | null;
        target_store_image: string | null;
        last_message: string | null;
        last_message_type: MessageType | null;
        last_message_at: Date | null;
        unread_count: number;
    })[]>(
        `SELECT
            c.conv_id, c.channel, c.subject, c.status, c.st_id, c.created_at, c.updated_at,
            source_store.st_id AS source_store_id,
            source_store.st_company_name AS source_store_name,
            source_store.st_email AS source_store_email,
            source_store.st_image AS source_store_image,
            target_store.st_id AS target_store_id,
            target_store.st_company_name AS target_store_name,
            target_store.st_email AS target_store_email,
            target_store.st_image AS target_store_image,
            (
                SELECT m.body FROM messages m
                WHERE m.conv_id = c.conv_id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message,
            (
                SELECT m.message_type FROM messages m
                WHERE m.conv_id = c.conv_id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message_type,
            (
                SELECT m.created_at FROM messages m
                WHERE m.conv_id = c.conv_id AND m.deleted_at IS NULL
                ORDER BY m.created_at DESC LIMIT 1
            ) AS last_message_at,
            (
                SELECT COUNT(*) FROM messages m
                LEFT JOIN Employees se ON se.e_id = m.sender_id AND m.sender_type = 'employee'
                WHERE m.conv_id = c.conv_id
                  AND m.sender_type = 'employee'
                  AND m.deleted_at IS NULL
                  AND COALESCE(se.st_id, 0) <> ?
                  AND m.msg_id > IFNULL(
                      (SELECT cp2.last_read_msg_id FROM Conversation_participants cp2
                       WHERE cp2.conv_id = c.conv_id AND cp2.actor_type = 'employee' AND cp2.actor_id = ? LIMIT 1),
                      0
                  )
            ) AS unread_count
         FROM Conversations c
         INNER JOIN Conversation_participants cp_store
           ON cp_store.conv_id = c.conv_id
          AND cp_store.actor_type = 'store'
          AND cp_store.actor_id <> c.st_id
         INNER JOIN Store source_store ON source_store.st_id = cp_store.actor_id
         INNER JOIN Store target_store ON target_store.st_id = c.st_id
         WHERE c.channel = 'support'
           AND (c.st_id = ? OR cp_store.actor_id = ?)
           AND (
              CASE WHEN c.st_id = ? THEN source_store.is_platform_store ELSE target_store.is_platform_store END
           ) = ?
         ORDER BY c.updated_at DESC, c.conv_id DESC`,
        [storeId, empId, storeId, storeId, storeId, platformStore ? 0 : 1]
    );

    // กันห้องร้านต่อร้านซ้ำจากข้อมูลเดิม: 1 คู่ร้านควรแสดงแค่ 1 ห้องล่าสุด
    const seenStoreTargets = new Set<number>();
    const supportRows = supportRowsRaw.filter(row => {
        const otherStoreId = Number(row.st_id) === Number(storeId)
            ? Number(row.source_store_id)
            : Number(row.target_store_id);
        if (seenStoreTargets.has(otherStoreId)) return false;
        seenStoreTargets.add(otherStoreId);
        return true;
    });

    const existingStoreTargets = new Set(
        supportRows.map(row => Number(row.st_id) === Number(storeId) ? Number(row.source_store_id) : Number(row.target_store_id))
    );
    const [contactRows] = await pool.query<(RowDataPacket & {
        st_id: number;
        st_company_name: string;
        st_email: string | null;
        st_image: string | null;
        is_platform_store: boolean | 0 | 1 | "0" | "1";
    })[]>(
        `SELECT st_id, st_company_name, st_email, st_image, is_platform_store
         FROM Store
         WHERE st_id <> ?
           AND is_platform_store = ?
         ORDER BY st_company_name ASC`,
        [storeId, platformStore ? 0 : 1]
    );

    const contacts: ConversationWithBuyerDTO[] = contactRows
        .filter(store => !existingStoreTargets.has(Number(store.st_id)))
        .map(store => ({
            conv_id: -Number(store.st_id),
            channel: "support",
            subject: "ติดต่อร้านค้า",
            status: "open",
            st_id: Number(store.st_id),
            created_at: new Date(0),
            updated_at: new Date(0),
            buyer_id: Number(store.st_id),
            buyer_username: store.st_company_name,
            buyer_email: store.st_email,
            buyer_avatar: store.st_image,
            target_store_id: Number(store.st_id),
            is_contact: true,
            last_message: null,
            last_message_type: null,
            last_message_at: null,
            unread_count: 0,
        }));

    const supportConversations: ConversationWithBuyerDTO[] = supportRows.map(row => {
        const otherStore = Number(row.st_id) === Number(storeId)
            ? {
                id: Number(row.source_store_id),
                name: row.source_store_name,
                email: row.source_store_email,
                image: row.source_store_image,
            }
            : {
                id: Number(row.target_store_id),
                name: row.target_store_name,
                email: row.target_store_email,
                image: row.target_store_image,
            };

        return {
            conv_id: row.conv_id,
            channel: row.channel,
            subject: row.subject,
            status: row.status,
            st_id: row.st_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
            buyer_id: otherStore.id,
            buyer_username: otherStore.name,
            buyer_email: otherStore.email,
            buyer_avatar: otherStore.image,
            target_store_id: otherStore.id,
            is_contact: false,
            last_message: row.last_message,
            last_message_type: row.last_message_type,
            last_message_at: row.last_message_at,
            unread_count: row.unread_count,
        };
    });

    return [...contacts, ...supportConversations, ...buyerRows];
}

export async function adminGetMessages(conv_id: number, storeId: number): Promise<MessageDTO[]> {
    if (!await canAdminAccessConversation(conv_id, storeId))
        throw new ApiError(403, "ไม่มีสิทธิ์เข้าถึงการสนทนานี้");

    const [rows] = await pool.query<(RowDataPacket & MessageDTO)[]>(
        `${selectMessageSql()} WHERE m.conv_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at ASC`,
        [conv_id]
    );
    return rows;
}

export async function adminMarkAsRead(conv_id: number, storeId: number, empId: number): Promise<void> {
    // mark read เป็นงานเสริมของ UI ถ้าห้องไม่ใช่สิทธิ์ของร้านนี้ให้ no-op
    // เพื่อไม่ให้หน้าแชทเด้ง error ทั้งที่การอ่าน/ส่งข้อความยังถูกคุมสิทธิ์ด้วย get/send อยู่
    if (!await canAdminAccessConversation(conv_id, storeId)) return;

    // หา msg_id ล่าสุดในห้องนี้
    const [lastMsg] = await pool.query<(RowDataPacket & { max_id: number | null })[]>(
        `SELECT MAX(msg_id) AS max_id FROM messages WHERE conv_id = ? AND deleted_at IS NULL`,
        [conv_id]
    );
    const lastMsgId = lastMsg[0]?.max_id ?? 0;
    if (!lastMsgId) return;

    // upsert แถว admin ใน Conversation_participants
    const [existing] = await pool.query<RowDataPacket[]>(
        `SELECT cp_id FROM Conversation_participants
         WHERE conv_id = ? AND actor_type = 'employee' AND actor_id = ?`,
        [conv_id, empId]
    );

    if (existing[0]) {
        await pool.query(
            `UPDATE Conversation_participants SET last_read_msg_id = ? WHERE conv_id = ? AND actor_type = 'employee' AND actor_id = ?`,
            [lastMsgId, conv_id, empId]
        );
    } else {
        await pool.query(
            `INSERT INTO Conversation_participants (actor_type, actor_id, role_in_conv, joined_at, last_read_msg_id, conv_id)
             VALUES ('employee', ?, 'agent', NOW(), ?, ?)`,
            [empId, lastMsgId, conv_id]
        );
    }
}

export async function adminSendImages(
    conv_id: number,
    storeId: number,
    empId: number,
    files: Express.Multer.File[]
): Promise<MessageDTO[]> {
    if (!await canAdminAccessConversation(conv_id, storeId))
        throw new ApiError(403, "ไม่มีสิทธิ์เข้าถึงการสนทนานี้");

    cancelAutoReply(conv_id);
    if (!files.length) throw new ApiError(400, "กรุณาแนบรูปภาพ");

    const [convRows] = await pool.query<(RowDataPacket & { st_id: number })[]>(
        `SELECT st_id FROM Conversations WHERE conv_id = ?`,
        [conv_id]
    );
    const targetStoreId = convRows[0]?.st_id;
    const [participantUsers] = await pool.query<(RowDataPacket & { actor_id: number })[]>(
        `SELECT actor_id FROM Conversation_participants WHERE conv_id = ? AND actor_type = 'user'`,
        [conv_id]
    );

    const messages: MessageDTO[] = [];
    for (const [index, file] of files.entries()) {
        const imagePath = await fileUploadImage(file, `chat_${conv_id}_${Date.now()}_${index}`, "chat");

        const [result] = await pool.query<ResultSetHeader>(
            `INSERT INTO messages (conv_id, sender_type, sender_id, message_type, body, created_at)
             VALUES (?, 'employee', ?, 'image', ?, NOW())`,
            [conv_id, empId, imagePath]
        );
        const [rows] = await pool.query<(RowDataPacket & MessageDTO)[]>(
            `${selectMessageSql()} WHERE m.msg_id = ?`,
            [result.insertId]
        );
        const message = rows[0]!;

        try {
            const io = getIO();
            io.to(`CONV_${conv_id}`).emit('new_message', message);
            if (targetStoreId) io.to(`STORE_${targetStoreId}`).emit('chat:new_message', { conv_id, message });
            participantUsers.forEach(user => {
                io.to(`USER_${user.actor_id}`).emit('chat:new_message', { conv_id, message });
            });
        } catch { /* no-op */ }

        messages.push(message);
    }

    await pool.query(`UPDATE Conversations SET updated_at = NOW() WHERE conv_id = ?`, [conv_id]);
    return messages;
}

export async function adminSendMessage(
    conv_id: number,
    storeId: number,
    empId: number,
    body: string,
    message_type: string = 'text'
): Promise<MessageDTO> {
    if (!await canAdminAccessConversation(conv_id, storeId))
        throw new ApiError(403, "ไม่มีสิทธิ์เข้าถึงการสนทนานี้");

    cancelAutoReply(conv_id);

    const [convRows] = await pool.query<(RowDataPacket & { st_id: number })[]>(
        `SELECT st_id FROM Conversations WHERE conv_id = ?`,
        [conv_id]
    );
    const targetStoreId = convRows[0]?.st_id;
    const [participantStores] = await pool.query<(RowDataPacket & { actor_id: number })[]>(
        `SELECT actor_id FROM Conversation_participants WHERE conv_id = ? AND actor_type = 'store'`,
        [conv_id]
    );
    // ดึง buyer ของห้องนี้ เพื่อ emit ไปที่ USER room ให้ storefront อัปเดต unread badge ได้ทันที
    const [participantUsers] = await pool.query<(RowDataPacket & { actor_id: number })[]>(
        `SELECT actor_id FROM Conversation_participants WHERE conv_id = ? AND actor_type = 'user'`,
        [conv_id]
    );

    const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO messages (conv_id, sender_type, sender_id, message_type, body, created_at)
         VALUES (?, 'employee', ?, ?, ?, NOW())`,
        [conv_id, empId, message_type, body]
    );

    const [rows] = await pool.query<(RowDataPacket & MessageDTO)[]>(
        `${selectMessageSql()} WHERE m.msg_id = ?`,
        [result.insertId]
    );

    const message = rows[0]!;

    try {
        const io = getIO();
        io.to(`CONV_${conv_id}`).emit('new_message', message);
        if (targetStoreId) io.to(`STORE_${targetStoreId}`).emit('chat:new_message', { conv_id, message });
        participantStores.forEach(store => {
            io.to(`STORE_${store.actor_id}`).emit('chat:new_message', { conv_id, message });
        });
        // แจ้ง buyer ผ่าน USER room — storefront ใช้ room นี้อัปเดต unread badge แบบ real-time
        participantUsers.forEach(user => {
            io.to(`USER_${user.actor_id}`).emit('chat:new_message', { conv_id, message });
        });
    } catch { /* no-op */ }

    await pool.query(`UPDATE Conversations SET updated_at = NOW() WHERE conv_id = ?`, [conv_id]);

    return message;
}
