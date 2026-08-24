import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import * as service from "./chat.service.js";

// ── Buyer ──────────────────────────────────────────────────────────────────

export const getOrCreateConversation = asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const stId = Number(req.body?.st_id) || undefined;
    const conv = await service.getOrCreateConversation(userId, stId);
    res.json({ data: conv });
});

export const listConversations = asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conversations = await service.listConversations(userId);
    res.json({ data: conversations });
});

export const getMessages = asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conv_id = Number(req.params.conv_id);
    if (!conv_id) throw new ApiError(400, "conv_id ไม่ถูกต้อง");
    const messages = await service.getMessages(conv_id, userId);
    res.json({ data: messages });
});

export const markAsRead = asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conv_id = Number(req.params.conv_id);
    if (!conv_id) throw new ApiError(400, "conv_id ไม่ถูกต้อง");
    await service.markAsRead(conv_id, userId);
    res.json({ success: true });
});

export const sendMessage = asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conv_id = Number(req.params.conv_id);
    if (!conv_id) throw new ApiError(400, "conv_id ไม่ถูกต้อง");
    const { body, message_type } = req.body ?? {};
    if (!body?.trim()) throw new ApiError(400, "กรุณาระบุข้อความ");
    const message = await service.sendMessage(conv_id, userId, body.trim(), message_type ?? 'text');
    res.status(201).json({ data: message });
});

export const sendImages = asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conv_id = Number(req.params.conv_id);
    if (!conv_id) throw new ApiError(400, "conv_id ไม่ถูกต้อง");
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) throw new ApiError(400, "กรุณาแนบรูปภาพ");
    const messages = await service.sendImageMessages(conv_id, userId, files);
    res.status(201).json({ data: messages });
});

// ── Admin ──────────────────────────────────────────────────────────────────

export const adminListConversations = asyncHandler(async (req, res) => {
    const storeId = req.storeId;
    const empId = req.empId;

    if (!storeId || !empId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conversations = await service.adminGetConversations(storeId, empId);
    res.json({ data: conversations });
});

export const adminGetOrCreateStoreConversation = asyncHandler(async (req, res) => {
    const storeId = req.storeId;
    if (!storeId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const targetStoreId = Number(req.body?.target_store_id);
    if (!targetStoreId) throw new ApiError(400, "target_store_id ไม่ถูกต้อง");
    const conversation = await service.adminGetOrCreateStoreConversation(storeId, targetStoreId);
    res.json({ data: conversation });
});

// หา/สร้างห้องแชทระหว่างร้านนี้กับ buyer ตาม buyer_id
// ถ้ามีห้อง open อยู่แล้วจะคืน conv เดิม ถ้าไม่มีจะสร้างใหม่
export const adminGetOrCreateBuyerConversation = asyncHandler(async (req, res) => {
    const storeId = req.storeId;
    if (!storeId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const buyerId = Number(req.body?.buyer_id);
    if (!buyerId) throw new ApiError(400, "buyer_id ไม่ถูกต้อง");
    const conversation = await service.adminGetOrCreateBuyerConversation(storeId, buyerId);
    res.json({ data: conversation });
});

export const adminGetMessages = asyncHandler(async (req, res) => {
    const storeId = req.storeId;
    const empId = req.empId;
    if (!storeId || !empId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conv_id = Number(req.params.conv_id);
    if (!conv_id) throw new ApiError(400, "conv_id ไม่ถูกต้อง");

    const messages = await service.adminGetMessages(conv_id, storeId);
    res.json({ data: messages });
});

export const adminMarkAsRead = asyncHandler(async (req, res) => {
    const storeId = req.storeId;
    const empId = req.empId;
    if (!storeId || !empId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conv_id = Number(req.params.conv_id);
    if (!conv_id) throw new ApiError(400, "conv_id ไม่ถูกต้อง");
    await service.adminMarkAsRead(conv_id, storeId, empId);
    res.json({ success: true });
});

export const adminSendImages = asyncHandler(async (req, res) => {
    const storeId = req.storeId;
    const empId = req.empId;
    if (!storeId || !empId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conv_id = Number(req.params.conv_id);
    if (!conv_id) throw new ApiError(400, "conv_id ไม่ถูกต้อง");
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) throw new ApiError(400, "กรุณาแนบรูปภาพ");
    const messages = await service.adminSendImages(conv_id, storeId, empId, files);
    res.status(201).json({ data: messages });
});

export const adminSendMessage = asyncHandler(async (req, res) => {
    const storeId = req.storeId;
    const empId = req.empId;
    if (!storeId || !empId) throw new ApiError(401, "ไม่ได้เข้าสู่ระบบ");
    const conv_id = Number(req.params.conv_id);
    if (!conv_id) throw new ApiError(400, "conv_id ไม่ถูกต้อง");
    const { body, message_type } = req.body ?? {};
    if (!body?.trim()) throw new ApiError(400, "กรุณาระบุข้อความ");
    const message = await service.adminSendMessage(conv_id, storeId, empId, body.trim(), message_type ?? 'text');
    res.status(201).json({ data: message });
});
