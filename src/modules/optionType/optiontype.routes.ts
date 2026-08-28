import { Router } from "express";
import * as controller from "./optionType.controller.js";
import { Auth } from "../../shared/middlewares/auth.js";

export const OptionTypeRouter = Router();

OptionTypeRouter.get("/", controller.getlist);
OptionTypeRouter.get("/:lang", controller.getListByLanguage);
OptionTypeRouter.use(Auth);
OptionTypeRouter.post("/", controller.create);
OptionTypeRouter.put("/:otype_id", controller.update);
OptionTypeRouter.delete("/:otype_id", controller.remove);
