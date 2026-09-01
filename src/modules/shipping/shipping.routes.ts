import { Router } from "express";
import { Auth } from "../../shared/middlewares/auth.js";
import * as ctrl from "./shipping.controller.js";

export const shippingRouter = Router();
shippingRouter.get("/carriers", Auth, ctrl.listCarriers);
shippingRouter.post("/carriers", Auth, ctrl.createCarrier);
shippingRouter.put("/carriers/:sc_id", Auth, ctrl.updateCarrier);
shippingRouter.patch("/carriers/:sc_id/toggle", Auth, ctrl.toggleCarrier);
shippingRouter.delete("/carriers/:sc_id", Auth, ctrl.deleteCarrier);
shippingRouter.post("/calculate", Auth, ctrl.calculateShipping);
