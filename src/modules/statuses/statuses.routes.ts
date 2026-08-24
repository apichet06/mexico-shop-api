import { Router } from "express";
import { Auth } from "../../shared/middlewares/auth.js";
import * as controller from "./statuses.controller.js";

export const statusRouters = Router();

statusRouters.use(Auth);
statusRouters.get("/:lg_code", controller.list);
statusRouters.put("/:s_id/:lg_code", controller.update);
