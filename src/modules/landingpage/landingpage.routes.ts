import { Router } from "express";
import multer from "multer";
import { Auth } from "../../shared/middlewares/auth.js";
import * as controller from "./landingpage.controller.js";

export const landingPageRouter = Router();

const upload = multer({
    dest: "public/uploads/",
    limits: {
        fieldSize: 20 * 1024 * 1024,
        fileSize: 5 * 1024 * 1024,
    },
});
landingPageRouter.get("/slug", controller.GetLandingPagesluge);

landingPageRouter.get("/slug/:slug", controller.GetUniqueSlug);
landingPageRouter.get("/lp/:slug/:lg_code", controller.GetLandingPageProductId);
landingPageRouter.use(Auth);
landingPageRouter.get("/:st_id/:lg_code", controller.List);

landingPageRouter.post("/", upload.single("lp_imag_url"), controller.CreateLandingPage);
landingPageRouter.put("/:lp_id", upload.single("lp_imag_url"), controller.UpdateLandingPage);
landingPageRouter.delete("/:group_id", controller.DeleteLandingPage);

