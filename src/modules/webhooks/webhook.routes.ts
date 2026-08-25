import { Router } from "express";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { handleChargeComplete } from "../payments/payment.service.js";

export const webhookRouter = Router();

/**
 * POST /webhooks/omise
 *
 * รับ event จาก Omise webhook ทุกประเภท
 * Omise จะส่ง POST มาที่ endpoint นี้เมื่อสถานะของ charge เปลี่ยนแปลง
 *
 * Event ที่รองรับ:
 *   charge.complete  — ลูกค้าชำระเงิน PromptPay สำเร็จ/ล้มเหลว → อัพเดทสถานะ payment + order
 *
 * ตอบ 200 เสมอเพื่อบอก Omise ว่าได้รับ event แล้ว
 * ถ้าตอบ 4xx/5xx Omise จะ retry ซ้ำหลายครั้ง
 */
webhookRouter.post("/omise", asyncHandler(async (req, res) => {
    // Omise ส่ง event มาในรูปแบบ { key, data: { id, status, paid, ... } }
    const event = req.body as {
        key?: string;
        data?: {
            id?: string;
            status?: string;
            paid?: boolean;
        };
    };

    const key = event?.key;
    const resourceId = event?.data?.id;

    // ถ้าไม่มี key หรือ id ถือว่าเป็น event ที่ระบบยังไม่รองรับ ตอบ 200 ไปก่อน
    if (!key || !resourceId) {
        res.status(200).json({ received: true });
        return;
    }

    // --- Charge events ---
    if (key === "charge.complete") {
        // PromptPay ลูกค้าสแกน QR แล้ว — Omise ส่ง event นี้มาบอกว่า charge เสร็จสิ้น (สำเร็จหรือล้มเหลว)
        // card payment จะ resolve ทันทีตอนสร้าง charge จึงไม่ต้องรอ event นี้
        const chargeStatus = event.data?.status ?? "";
        const chargePaid = event.data?.paid ?? false;
        await handleChargeComplete(resourceId, chargeStatus, chargePaid);
    }

    res.status(200).json({ received: true });
}));
