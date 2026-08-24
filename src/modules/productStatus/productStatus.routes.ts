import { Router } from "express";
import * as controller from "./productStatus.controller.js"

export const productStatus = Router();

productStatus.get("/", controller.List)