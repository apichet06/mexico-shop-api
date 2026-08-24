import Router from "express";
import * as controller from "./units.controller.js";
import { Auth } from "../../shared/middlewares/auth.js";

export const unitRouters = Router();

unitRouters.get("/:lang", controller.listByLang)
unitRouters.use(Auth);
unitRouters.get("/", controller.list)
unitRouters.post("/", controller.create)
unitRouters.put("/:ul_id", controller.update)
unitRouters.delete("/:u_id", controller.deleteUnit)