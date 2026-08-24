import { Router } from "express";
import multer from "multer";
import * as controller from "./chat.controller.js";
import { BuyerAuth } from "../../shared/middlewares/buyerAuth.js";
import { Auth } from "../../shared/middlewares/auth.js";

export const chatRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Buyer routes
chatRouter.get("/conversations", BuyerAuth, controller.listConversations);
chatRouter.post("/conversations", BuyerAuth, controller.getOrCreateConversation);
chatRouter.get("/conversations/:conv_id/messages", BuyerAuth, controller.getMessages);
chatRouter.patch("/conversations/:conv_id/read", BuyerAuth, controller.markAsRead);
chatRouter.post("/conversations/:conv_id/messages", BuyerAuth, controller.sendMessage);
chatRouter.post("/conversations/:conv_id/images", BuyerAuth, upload.array("images", 5), controller.sendImages);

// Admin routes (employee JWT)
chatRouter.get("/admin/conversations", Auth, controller.adminListConversations);
chatRouter.post("/admin/store-conversation", Auth, controller.adminGetOrCreateStoreConversation);
// หา/สร้างห้องแชทกับ buyer เฉพาะราย ใช้โดย backoffice เมื่อต้องการส่งแจ้งเตือนอัตโนมัติ (เช่น อนุมัติ/ปฏิเสธ refund)
chatRouter.post("/admin/buyer-conversation", Auth, controller.adminGetOrCreateBuyerConversation);
chatRouter.get("/admin/conversations/:conv_id/messages", Auth, controller.adminGetMessages);
chatRouter.patch("/admin/conversations/:conv_id/read", Auth, controller.adminMarkAsRead);
chatRouter.post("/admin/conversations/:conv_id/messages", Auth, controller.adminSendMessage);
chatRouter.post("/admin/conversations/:conv_id/images", Auth, upload.array("images", 5), controller.adminSendImages);
