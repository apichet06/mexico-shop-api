import Router from "express";
import * as controller from "./productTags.controller.js";
import { Auth } from "../../shared/middlewares/auth.js";

export const ProductTagRouter = Router();

ProductTagRouter.use(Auth);
ProductTagRouter.get("/:lg_code", controller.list)
ProductTagRouter.post("/", controller.create)
ProductTagRouter.put("/:ptt_id", controller.update)
ProductTagRouter.delete("/:ptag_id", controller.deleteProductTag)