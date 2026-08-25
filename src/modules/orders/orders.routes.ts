import { Router } from "express";
import multer from "multer";
import { BuyerAuth } from "../../shared/middlewares/buyerAuth.js";
import { Auth } from "../../shared/middlewares/auth.js";
import * as controller from "./orders.controller.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

export const orderRouter = Router();

orderRouter.post("/checkout", BuyerAuth, controller.checkoutOrder);
orderRouter.post("/", BuyerAuth, controller.createOrder);
orderRouter.get("/shipping-options", BuyerAuth, controller.getShippingOptions);
orderRouter.get("/admin/summary", Auth, controller.adminGetOrderSummary);
orderRouter.get("/admin/reports/sales", Auth, controller.adminGetSalesReport);
orderRouter.get("/admin/reports/sales-by-product", Auth, controller.adminGetSalesByProductReport);
orderRouter.get("/admin/reports/sales-by-category", Auth, controller.adminGetSalesByCategoryReport);
orderRouter.get("/admin/reports/sales-by-buyer", Auth, controller.adminGetSalesByBuyerReport);
orderRouter.patch("/admin/:or_id/status", Auth, controller.adminUpdateStatus);
orderRouter.patch("/admin/:or_id/cancel", Auth, controller.adminCancelOrder);
orderRouter.patch("/admin/:or_id/tracking", Auth, controller.adminUpdateTracking);
orderRouter.post("/admin/:or_id/shipment", Auth, controller.adminCreateShipment);
orderRouter.post("/admin/:or_id/dev/delivered", Auth, controller.adminDevMarkDelivered);
orderRouter.patch("/admin/:or_id/refund/approve", Auth, controller.adminApproveRefund);
orderRouter.patch("/admin/:or_id/refund/manual-confirm", Auth, controller.adminConfirmManualRefund);
orderRouter.patch("/admin/:or_id/refund/reject", Auth, controller.adminRejectRefund);
orderRouter.post("/admin/:or_id/return/confirm-received", Auth, controller.adminConfirmReturnReceived);
orderRouter.get("/admin/:or_id", Auth, controller.adminGetOrderById);
orderRouter.get("/admin", Auth, controller.adminGetOrders);
orderRouter.get("/", BuyerAuth, controller.getOrders);
orderRouter.patch("/:or_id/received", BuyerAuth, controller.confirmOrderReceived);
orderRouter.patch("/:or_id/cancel", BuyerAuth, controller.cancelOrder);
orderRouter.post("/:or_id/refund-request", BuyerAuth, upload.array("images", 3), controller.requestRefund);
orderRouter.get("/:or_id", BuyerAuth, controller.getOrderById);
