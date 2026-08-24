import { asyncHandler } from "../../shared/utils/asyncHandler.js"
import { ApiError } from "../../shared/errors/ApiError.js"
import { fileUploadImage } from "../../shared/middlewares/fileUploadImage.js"
import * as service from "./website-theme.service.js"
import type { UpsertThemeInput, WebsiteKey } from "./website-theme.type.js"
import type { Request, Response } from "express"

const VALID_KEYS: WebsiteKey[] = ["arcana", "deadstock"]

function parseWebsiteKey(key: string | string[] | undefined): WebsiteKey {
    const k = Array.isArray(key) ? key[0] : key
    if (!k || !VALID_KEYS.includes(k as WebsiteKey)) {
        throw new ApiError(400, `website_key ไม่ถูกต้อง: ${k}`)
    }
    return k as WebsiteKey
}

export const getTheme = asyncHandler(async (req: Request, res: Response) => {
    const key = parseWebsiteKey(req.params.websiteKey)
    const theme = await service.getTheme(key)
    res.json({ data: theme })
})

export const uploadImage = asyncHandler(async (req: Request, res: Response) => {
    const file = req.file
    if (!file) throw new ApiError(400, "ไม่พบไฟล์รูปภาพ")

    const requestedFolder = typeof req.body?.folder === "string" ? req.body.folder : "theme"
    const folder = requestedFolder === "hero" ? "hero" : "theme"
    const key = `${folder}-${Date.now()}`
    const relativePath = await fileUploadImage(file, key, folder)

    res.json({ url: relativePath })
})

export const upsertTheme = asyncHandler(async (req: Request, res: Response) => {
    const key = parseWebsiteKey(req.params.websiteKey)
    const input = req.body as UpsertThemeInput

    if (!input.bg_type || !["color", "image"].includes(input.bg_type)) {
        throw new ApiError(400, "bg_type ต้องเป็น color หรือ image")
    }

    await service.upsertTheme(key, input)
    res.json({ message: "บันทึกสำเร็จ" })
})

export const upsertHeroBackground = asyncHandler(async (req: Request, res: Response) => {
    const key = parseWebsiteKey(req.params.websiteKey)
    const input = req.body

    if (!input.hero_bg_type || !["color", "image"].includes(input.hero_bg_type)) {
        throw new ApiError(400, "hero_bg_type ต้องเป็น color หรือ image")
    }

    await service.upsertHeroBackground(key, input)
    res.json({ message: "บันทึกสำเร็จ" })
})

export const upsertHeroSlides = asyncHandler(async (req: Request, res: Response) => {
    const key = parseWebsiteKey(req.params.websiteKey)
    const slides = Array.isArray(req.body?.slides) ? req.body.slides : []

    await service.upsertHeroSlides(key, slides)
    res.json({ message: "บันทึกสำเร็จ" })
})

export const cleanupUnusedImages = asyncHandler(async (_req: Request, res: Response) => {
    const result = await service.cleanupUnusedWebsiteImages()
    res.json({
        message: "ล้างรูปภาพที่ไม่ได้ใช้งานสำเร็จ",
        deleted_count: result.deleted.length,
        failed_count: result.failed.length,
        deleted: result.deleted,
        failed: result.failed,
    })
})
