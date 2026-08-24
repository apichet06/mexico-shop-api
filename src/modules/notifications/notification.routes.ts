
import { Router } from "express";
import * as controller from "./notification.controller.js";
import { Auth } from "../../shared/middlewares/auth.js";
import { BuyerAuth } from "../../shared/middlewares/buyerAuth.js";

export const NotiRouter = Router();

NotiRouter.get("/me", BuyerAuth, controller.listBuyer)
NotiRouter.patch("/me/read-all", BuyerAuth, controller.markBuyerAllAsRead)
NotiRouter.patch("/me/:noti_id/read", BuyerAuth, controller.markBuyerAsRead)

NotiRouter.use(Auth);
NotiRouter.get("/:st_id", controller.list)
NotiRouter.patch("/:noti_id/read", controller.markAsRead)
NotiRouter.patch("/store/:st_id/read-all", controller.markAllAsRead)
