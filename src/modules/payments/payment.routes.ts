import { Router } from "express";
import { BuyerAuth } from "../../shared/middlewares/buyerAuth.js";
import * as controller from "./payment.controller.js";

export const paymentRouter = Router();

paymentRouter.post("/mercado-pago/checkout", BuyerAuth, controller.createMercadoPagoCheckout);
paymentRouter.post("/mercado-pago/sync", BuyerAuth, controller.syncMercadoPagoPayment);
