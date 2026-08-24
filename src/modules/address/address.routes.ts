import { Router } from "express";
import * as controller from "./address.controller.js";

export const AddressRouter = Router();

AddressRouter.get("/province/", controller.listProvinces);
AddressRouter.get("/district/:id", controller.listDistricts);
AddressRouter.get("/subdistrict/:id", controller.listSubDistricts);

