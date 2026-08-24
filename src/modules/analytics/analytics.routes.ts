import { Router } from "express";
import { Auth } from "../../shared/middlewares/auth.js";
import * as controller from "./analytics.controller.js";

export const analyticsRouter = Router();

// Public endpoint สำหรับ storefront analytics: payload ไม่มีข้อมูลสำคัญ และ service จะ hash id ก่อนเก็บ
analyticsRouter.post("/events", controller.recordEvent);

// Admin endpoint สำหรับ backoffice dashboard
analyticsRouter.get("/admin/report", Auth, controller.getAdminReport);
