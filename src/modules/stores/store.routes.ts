import { Router } from "express";
import multer from "multer";
import * as controller from "./store.controller.js";
import { Auth } from "../../shared/middlewares/auth.js";

export const storeRouter = Router();

// ===== Multer config: ใช้ memoryStorage =====
const upload = multer({
  storage: multer.memoryStorage(), //  เก็บใน RAM ก่อน
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedImageTypes = ["image/jpeg", "image/png", "image/webp"];
    const allowedDocTypes = ["application/pdf", "image/jpeg", "image/png"];

    if (file.fieldname === "st_image") {
      if (!allowedImageTypes.includes(file.mimetype)) {
        return cb(new Error("Solo se admiten archivos JPG, PNG, WEBP"));
      }
    } else if (file.fieldname.startsWith("doc_")) {
      if (!allowedDocTypes.includes(file.mimetype)) {
        return cb(new Error("Solo se admiten archivos PDF, JPG, PNG"));
      }
    }
    cb(null, true);
  },
});

const uploadStoreRegister = upload.fields([
  { name: "st_image", maxCount: 1 },
  { name: "doc_VAT_CERT", maxCount: 5 },
  { name: "doc_COMPANY_CERT", maxCount: 5 },
  { name: "doc_ID_CARD", maxCount: 5 },
  { name: "doc_OTHER", maxCount: 5 },
]);

// ===== Routes =====
storeRouter.get("/shop/", controller.listShop);
storeRouter.get("/shop/:st_id", controller.listShopById);
storeRouter.get("/company-name/:st_company_name", controller.existsCompanyName);
storeRouter.get("/email/:st_email", controller.existsEmailStore);
storeRouter.get("/email-employee/:e_email", controller.existsEmailEmployee);
storeRouter.get("/banks", controller.listBanks);
storeRouter.get(
  "/seller-confirmations/:token",
  controller.getSellerConfirmation,
);
storeRouter.post(
  "/seller-confirmations/:token/confirm",
  controller.confirmSellerConfirmation,
);
storeRouter.post(
  "/email-verifications/:token/confirm",
  controller.confirmStoreEmail,
);
// storeRouter.post("/", upload.single("st_image"), controller.create);

storeRouter.use(Auth);
storeRouter.post(
  "/storesregister",
  uploadStoreRegister,
  controller.createRegister,
);
storeRouter.post(
  "/:st_id/resend-seller-confirmation",
  controller.resendSellerConfirmation,
);
storeRouter.post(
  "/:st_id/resend-store-email-verification",
  controller.resendStoreEmailVerification,
);
storeRouter.get("/:st_id", controller.getById);
storeRouter.get("/", controller.list);
storeRouter.put("/:st_id", upload.single("st_image"), controller.update);
storeRouter.delete("/:st_id", controller.deleteStore);
storeRouter.get("/:st_id/logStore", controller.getLogstore);
