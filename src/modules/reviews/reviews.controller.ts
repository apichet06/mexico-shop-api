import { asyncHandler } from "../../shared/utils/asyncHandler.js"
import { ApiError } from "../../shared/errors/ApiError.js"
import * as service from "./reviews.service.js"

// GET /api/reviews?pv_id=1&page=1&limit=10
export const list = asyncHandler(async (req, res) => {
    const pv_id = Number(req.query.pv_id)
    const page = Math.max(1, Number(req.query.page ?? 1))
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 10)))

    if (!pv_id || isNaN(pv_id)) throw new ApiError(400, "จำเป็นต้องระบุ pv_id")

    const result = await service.getReviews(pv_id, page, limit)
    res.json({ data: result })
})

// GET /api/reviews/check?pv_id=1  (ต้อง BuyerAuth)
// ตรวจว่า user มีสิทธิ์รีวิวหรือไม่ และคืน oi_id ที่ยังไม่ได้รีวิว
export const checkReviewable = asyncHandler(async (req, res) => {
    const u_id = req.userId
    const pv_id = Number(req.query.pv_id)

    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้")
    if (!pv_id) throw new ApiError(400, "จำเป็นต้องระบุ pv_id")

    const reviewableItems = await service.getReviewableItems(u_id, pv_id)
    res.json({ data: { canReview: reviewableItems.length > 0, oi_ids: reviewableItems } })
})

// POST /api/reviews  (ต้อง BuyerAuth, multipart/form-data)
export const create = asyncHandler(async (req, res) => {
    const u_id = req.userId
    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้")

    const { pv_id, oi_id, massages, delivery_score, product_score } = req.body ?? {}

    if (!pv_id || !oi_id) throw new ApiError(400, "กรุณากรอกข้อมูลให้ครบถ้วน")

    const reviewMessage = typeof massages === "string" ? massages.trim() : ""
    if (reviewMessage.length > 500) throw new ApiError(400, "ความคิดเห็นต้องไม่เกิน 500 ตัวอักษร")

    const dScore = Number(delivery_score)
    const pScore = Number(product_score)

    if (dScore < 1 || dScore > 5 || pScore < 1 || pScore > 5) {
        throw new ApiError(400, "คะแนนต้องอยู่ระหว่าง 1-5")
    }

    const imageFiles = (req.files as Express.Multer.File[]) ?? []

    await service.createReview({
        u_id,
        pv_id: Number(pv_id),
        oi_id: Number(oi_id),
        massages: reviewMessage,
        delivery_score: dScore,
        product_score: pScore,
        imageFiles,
    })

    res.status(201).json({ message: "รีวิวสำเร็จ" })
})


// GET /api/reviews/featured?website=arcana&lang=th&limit=8
export const featured = asyncHandler(async (req, res) => {
    const website = String(req.query.website ?? "")
        .trim()
        .toLowerCase()

    const requestedLanguage = String(req.query.lang ?? "th")
        .trim()
        .toLowerCase()

    const requestedLimit = Number(req.query.limit ?? 8)
    const limit = Number.isFinite(requestedLimit)
        ? Math.min(12, Math.max(1, requestedLimit))
        : 8

    const ctlId =
        website === "arcana"
            ? 1
            : website === "deadstock"
                ? 2
                : null

    if (!ctlId) {
        throw new ApiError(
            400,
            "website ต้องเป็น arcana หรือ deadstock"
        )
    }

    const language = ["th", "en", "ja"].includes(requestedLanguage)
        ? requestedLanguage
        : "th"

    const reviews = await service.getFeaturedProductReviews(
        ctlId,
        language,
        limit
    )

    res.json({
        data: {
            reviews,
        },
    })
})