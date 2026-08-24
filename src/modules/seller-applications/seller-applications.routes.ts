import { Router } from "express";
import multer from "multer";
import * as controller from "./seller-applications.controller.js";

export const sellerApplicationRouter = Router();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
    },
    fileFilter: (req, file, cb) => {
        const allowedImageTypes = ["image/jpeg", "image/png", "image/webp"];
        const allowedDocTypes = ["application/pdf", "image/jpeg", "image/png"];

        if (file.fieldname === "st_image") {
            if (!allowedImageTypes.includes(file.mimetype)) {
                return cb(new Error("รองรับเฉพาะไฟล์ JPG, PNG, WEBP"));
            }
        } else if (file.fieldname.startsWith("doc_")) {
            if (!allowedDocTypes.includes(file.mimetype)) {
                return cb(new Error("รองรับเฉพาะไฟล์ PDF, JPG, PNG"));
            }
        }
        cb(null, true);
    },
});

const uploadSellerApplicationRegister = upload.fields([
    { name: "st_image", maxCount: 1 },
    { name: "doc_VAT_CERT", maxCount: 5 },
    { name: "doc_COMPANY_CERT", maxCount: 5 },
    { name: "doc_ID_CARD", maxCount: 5 },
    { name: "doc_OTHER", maxCount: 5 },
]);

sellerApplicationRouter.post("/oauth/google", controller.googleStart);
sellerApplicationRouter.post("/oauth/facebook", controller.facebookStart);
sellerApplicationRouter.get("/me", controller.me);
sellerApplicationRouter.patch("/step", controller.saveStep);
sellerApplicationRouter.post("/finalize", uploadSellerApplicationRegister, controller.finalizeRegister);
