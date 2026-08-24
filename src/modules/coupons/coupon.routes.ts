import { Router } from "express";
import { Auth } from "../../shared/middlewares/auth.js";
import { BuyerAuth, OptionalBuyerAuth } from "../../shared/middlewares/buyerAuth.js";
import * as controller from "./coupon.controller.js";

export const couponRouter = Router();

couponRouter.get("/", Auth, controller.list);
couponRouter.post("/", Auth, controller.create);
couponRouter.get("/available", OptionalBuyerAuth, controller.available);
couponRouter.get("/available/:co_id/products", controller.availableProducts);
couponRouter.get("/me", BuyerAuth, controller.myCoupons);
couponRouter.post("/validate", BuyerAuth, controller.validate);
couponRouter.post("/:co_id/claim", BuyerAuth, controller.claim);
couponRouter.get("/:co_id", Auth, controller.detail);
couponRouter.get("/:co_id/products", Auth, controller.products);
couponRouter.put("/:co_id", Auth, controller.update);
couponRouter.delete("/:co_id", Auth, controller.remove);
