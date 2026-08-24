import { Router } from "express";
import * as controller from "./users.controller.js";
import { Auth } from "../../shared/middlewares/auth.js";

export const usersRouters = Router();

usersRouters.use(Auth);
usersRouters.get("/", controller.list);
usersRouters.get("/:id", controller.getById);
usersRouters.post("/", controller.create);
usersRouters.put("/:id", controller.update);
usersRouters.delete("/:id", controller.remove);
