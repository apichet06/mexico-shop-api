import { Router } from "express";
import * as controller from "./emp.controller.js";
import multer from "multer";
import { Auth } from "../../shared/middlewares/auth.js";


export const EmpRouter = Router();

const upload = multer({ dest: "public/uploads/" });

EmpRouter.post("/login", controller.login)
EmpRouter.post("/forgot-password", controller.forgotPassword)
EmpRouter.post("/reset-password", controller.resetPassword)
EmpRouter.get("/email-verifications/:token", controller.getEmailVerification)
EmpRouter.post("/email-verifications/:token/confirm", controller.confirmEmailVerification)
EmpRouter.use(Auth)
EmpRouter.get("/:st_id", controller.list)
EmpRouter.post("/", controller.createFullAdmin)
EmpRouter.post("/:e_id/resend-email-verification", controller.resendEmailVerification)
EmpRouter.put("/change-password/:e_id", controller.changePassword)
EmpRouter.put("/:e_id", controller.updatefullAdmin)
EmpRouter.delete("/:e_id", controller.deleteFullAdmin)


// EmpRouter.post("/", upload.fields([{ name: 'e_image', maxCount: 1 }, { name: 'st_image', maxCount: 1 }]), controller.create)
