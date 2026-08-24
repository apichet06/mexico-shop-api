import { Router } from 'express';
import * as controller from './brands.controller.js';

const BrandRouter = Router();

BrandRouter.get("/", controller.list)
BrandRouter.post("/", controller.create)
BrandRouter.put("/:b_id", controller.update)
BrandRouter.delete("/:b_id", controller.deleteBrand)

export default BrandRouter