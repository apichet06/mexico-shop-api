import { Router } from "express";
import { Auth } from "../../shared/middlewares/auth.js";
import * as ctrl from "./shipping.controller.js";

export const shippingRouter = Router();

// SHIPPOP official label is fetched server-side because SHIPPOP requires the API key.
shippingRouter.get("/labels/:tracking_code", ctrl.openShippopLabel);

// ─── Carriers ────────────────────────────────────────────────────────────────
shippingRouter.get("/carriers", Auth, ctrl.listCarriers);
shippingRouter.post("/carriers", Auth, ctrl.createCarrier);
shippingRouter.put("/carriers/:sc_id", Auth, ctrl.updateCarrier);
shippingRouter.patch("/carriers/:sc_id/toggle", Auth, ctrl.toggleCarrier);
shippingRouter.delete("/carriers/:sc_id", Auth, ctrl.deleteCarrier);

// ─── Rates ────────────────────────────────────────────────────────────────────
shippingRouter.get("/rates", Auth, ctrl.listRates);
shippingRouter.post("/rates", Auth, ctrl.createRate);
shippingRouter.put("/rates/:sr_id", Auth, ctrl.updateRate);
shippingRouter.delete("/rates/:sr_id", Auth, ctrl.deleteRate);

// ─── Zone Rules ───────────────────────────────────────────────────────────────
shippingRouter.get("/zones", Auth, ctrl.listZoneRules);
shippingRouter.post("/zones", Auth, ctrl.createZoneRule);
shippingRouter.put("/zones/:pzr_id", Auth, ctrl.updateZoneRule);
shippingRouter.delete("/zones/:pzr_id", Auth, ctrl.deleteZoneRule);

// ─── Calculator (admin test tool) ────────────────────────────────────────────
shippingRouter.post("/calculate", Auth, ctrl.calculateShipping);
