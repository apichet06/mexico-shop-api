import http from "http";
import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { startAutoReceiveDeliveredOrdersJob, startPaymentExpirationJob } from "./modules/orders/orders.service.js";
import { startAutoPayoutJob } from "./modules/orders/payout-cron.js";
import { initSocket } from "./socket/socket.js";


process.on("unhandledRejection", (err) => {
    console.error("UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", (err) => {
    console.error("UNCAUGHT EXCEPTION:", err);
});

const app = createApp();

const httpServer = http.createServer(app);

initSocket(httpServer);

// ตรวจสอบ order ที่หมดเวลาชำระเงินทุก 60 วินาที → ยกเลิกและคืน stock อัตโนมัติ
startPaymentExpirationJob();

// ยืนยันรับสินค้าอัตโนมัติเมื่อส่งสำเร็จครบ 2 วันและไม่มีคำขอคืนเงินค้างอยู่
startAutoReceiveDeliveredOrdersJob();

// โอนเงินให้ร้านที่เปิด auto transfer ทุกวัน 02:00 น. (Asia/Bangkok)
startAutoPayoutJob();

httpServer.listen(env.PORT, () => {
    console.log(`API running on http://localhost:${env.PORT}`);
});
