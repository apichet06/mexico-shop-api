import { Router } from "express";
import multer from "multer";
import * as controller from "./product.controller.js";
import { Auth } from "../../shared/middlewares/auth.js";

export const productRouter = Router();

const upload = multer({
    dest: "public/uploads/", limits: {
        fieldSize: 10 * 1024 * 1024, // ต่อ 1 field text
        fileSize: 5 * 1024 * 1024,   // ต่อ 1 file
        fields: 50,                  // จำนวน field text
        files: 10,                   // จำนวนไฟล์
        parts: 60,                   // รวมทุก part
    },
});

productRouter.use(Auth);
productRouter.get("/:lg_code", controller.list);
productRouter.get("/:p_id/variants", controller.getOptionVariant);
productRouter.post("/", upload.array("images", 3), controller.create);
productRouter.put("/:pl_id", upload.array("images", 3), controller.update);
productRouter.delete("/:p_id", controller.remove);
productRouter.post("/:p_id/variants", upload.array("images"), controller.createOptionVariant);
