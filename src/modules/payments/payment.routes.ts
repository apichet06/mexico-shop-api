import { Router } from "express";
import { BuyerAuth } from "../../shared/middlewares/buyerAuth.js";
import * as controller from "./payment.controller.js";

export const paymentRouter = Router();

paymentRouter.get("/methods", BuyerAuth, controller.listPaymentMethods);
paymentRouter.post("/methods/omise-card", BuyerAuth, controller.addPaymentMethod);
paymentRouter.patch("/methods/:id/default", BuyerAuth, controller.setDefaultPaymentMethod);
paymentRouter.delete("/methods/:id", BuyerAuth, controller.deletePaymentMethod);
paymentRouter.post("/omise/charge", BuyerAuth, controller.chargeOmise);
paymentRouter.post("/omise/sync", BuyerAuth, controller.syncPromptPayCharge);
