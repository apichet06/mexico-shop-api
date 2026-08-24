import { Router } from "express";
import { BuyerAuth } from "../../shared/middlewares/buyerAuth.js";
import * as controller from "./carts.controller.js";

export const cartRouter = Router();

cartRouter.get("/", BuyerAuth, controller.getCart);
cartRouter.post("/items", BuyerAuth, controller.addItem);
cartRouter.put("/items/:ci_id", BuyerAuth, controller.updateItemQty);
cartRouter.put("/items/:ci_id/select", BuyerAuth, controller.updateItem);
cartRouter.delete("/items/:ci_id", BuyerAuth, controller.DeleteItem)  
