import { Router } from "express";
import { BuyerAuth } from "../../shared/middlewares/buyerAuth.js";
import * as controller from "./payment.controller.js";

export const paymentRouter = Router();

paymentRouter.post("/conekta/checkout", BuyerAuth, controller.createConektaCheckout);
paymentRouter.post("/conekta/sync", BuyerAuth, controller.syncConektaPayment);
