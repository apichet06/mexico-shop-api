import http from "http";
import { env } from "./config/env.js";
import { createApp } from "./app.js";
import { startAutoReceiveDeliveredOrdersJob, startPaymentExpirationJob } from "./modules/orders/orders.service.js";
import { startConektaReconciliationJob } from "./modules/payments/payment.service.js";
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

// Revisa cada 60 segundos las órdenes cuyo tiempo de pago venció → cancela y devuelve el stock automáticamente (ตรวจสอบ order ที่หมดเวลาชำระเงินทุก 60 วินาที → ยกเลิกและคืน stock อัตโนมัติ)
startPaymentExpirationJob();
startConektaReconciliationJob();

// Confirma automáticamente la recepción del producto cuando han pasado 2 días desde la entrega exitosa y no hay solicitudes de reembolso pendientes (ยืนยันรับสินค้าอัตโนมัติเมื่อส่งสำเร็จครบ 2 วันและไม่มีคำขอคืนเงินค้างอยู่)
startAutoReceiveDeliveredOrdersJob();


httpServer.listen(env.PORT, () => {
    console.log(`API running on http://localhost:${env.PORT}`);
});
