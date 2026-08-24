import { Router } from "express";
import * as controller from "./location.controller.js";
import { Auth } from "../../shared/middlewares/auth.js";



export const LocationRouter = Router();

LocationRouter.use(Auth);
LocationRouter.get("/", controller.list);
LocationRouter.get("/:st_id", controller.getById);
LocationRouter.post("/", controller.create);
LocationRouter.put("/:loc_id", controller.update);
LocationRouter.delete("/:loc_id", controller.deleteLocation);