import { Router } from "express";
import multer from "multer";
import { Auth } from "../../shared/middlewares/auth.js";
import * as controller from "./articles.controller.js";

export const articleRouter = Router();

const upload = multer({
    dest: "public/uploads/",
    limits: {
        fieldSize: 20 * 1024 * 1024,
        fileSize: 5 * 1024 * 1024,
    },
});

articleRouter.get("/slug/:slug", controller.getUniqueSlug);
articleRouter.get("/public/:lg_code", controller.publicList);
articleRouter.get("/public/:slug/:lg_code", controller.getBySlug);

articleRouter.use(Auth);
articleRouter.get("/:st_id/:lg_code", controller.list);
articleRouter.post("/", upload.single("art_image_url"), controller.create);
articleRouter.put("/:art_id", upload.single("art_image_url"), controller.update);
articleRouter.delete("/:group_id", controller.remove);
