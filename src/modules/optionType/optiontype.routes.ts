import { Router } from "express";
import * as controller from "./optionType.controller.js";

export const OptionTypeRouter = Router();

OptionTypeRouter.get("/", controller.getlist)