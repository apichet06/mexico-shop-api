import { Router } from "express";
import { Auth } from "../../shared/middlewares/auth.js";
import * as controller from "./analytics.controller.js";

export const analyticsRouter = Router();

// Endpoint público para storefront analytics: el payload no tiene datos sensibles y el service hace hash del id antes de guardarlo (Public endpoint สำหรับ storefront analytics: payload ไม่มีข้อมูลสำคัญ และ service จะ hash id ก่อนเก็บ)
analyticsRouter.post("/events", controller.recordEvent);

// Endpoint de admin para el dashboard del backoffice (Admin endpoint สำหรับ backoffice dashboard)
analyticsRouter.get("/admin/report", Auth, controller.getAdminReport);
