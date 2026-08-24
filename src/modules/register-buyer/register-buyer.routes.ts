import { Router } from "express";
import * as controller from "./register-buyer.controller.js";
import { BuyerAuth } from "../../shared/middlewares/buyerAuth.js";

export const registerBuyerRouter = Router();

// Public — สมัคร / ล็อกอิน
registerBuyerRouter.post("/register", controller.register);
registerBuyerRouter.post("/login", controller.login);
registerBuyerRouter.post("/google", controller.googleLogin);
registerBuyerRouter.post("/facebook", controller.facebookLogin);
registerBuyerRouter.post("/refresh", controller.refresh);
registerBuyerRouter.post("/logout", controller.logout);
registerBuyerRouter.post("/forgot-password", controller.forgotPassword);
registerBuyerRouter.post("/reset-password", controller.resetPassword);

// Protected — ต้องล็อกอินก่อน (BuyerAuth ตรวจ JWT แล้วใส่ req.userId)
registerBuyerRouter.get("/me", BuyerAuth, controller.getMe);
registerBuyerRouter.patch("/me", BuyerAuth, controller.updateMe);
registerBuyerRouter.patch("/me/password", BuyerAuth, controller.changePassword);
registerBuyerRouter.get("/me/addresses", BuyerAuth, controller.getAddresses);
registerBuyerRouter.post("/me/addresses", BuyerAuth, controller.addAddress);
registerBuyerRouter.patch("/me/addresses/:id", BuyerAuth, controller.updateAddress);
registerBuyerRouter.patch("/me/addresses/:id/default", BuyerAuth, controller.setDefaultAddress);
registerBuyerRouter.delete("/me/addresses/:id", BuyerAuth, controller.deleteAddress);
