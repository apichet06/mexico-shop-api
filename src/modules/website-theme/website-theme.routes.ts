import { Router } from "express"
import multer from "multer"
import { Auth } from "../../shared/middlewares/auth.js"
import * as ctrl from "./website-theme.controller.js"

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

export const websiteThemeRouter = Router()

// GET — public (storefront reads without auth)
websiteThemeRouter.get("/:websiteKey", ctrl.getTheme)

// POST upload image — admin only
websiteThemeRouter.post("/upload-image", Auth, upload.single("image"), ctrl.uploadImage)

// DELETE unused uploaded theme/hero images — admin only
websiteThemeRouter.delete("/unused-images", Auth, ctrl.cleanupUnusedImages)

// PUT hero background — admin only
websiteThemeRouter.put("/:websiteKey/hero-background", Auth, ctrl.upsertHeroBackground)

// PUT hero slides — admin only
websiteThemeRouter.put("/:websiteKey/hero-slides", Auth, ctrl.upsertHeroSlides)

// PUT — admin only
websiteThemeRouter.put("/:websiteKey", Auth, ctrl.upsertTheme)
