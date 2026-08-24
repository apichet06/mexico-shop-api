import { Router } from "express"
import multer from "multer"
import { BuyerAuth } from "../../shared/middlewares/buyerAuth.js"
import * as controller from "./reviews.controller.js"

// รูปรีวิวเก็บใน memory (เหมือนกับ product image)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

export const reviewRouter = Router()

// Public — ดูรีวิวของสินค้า
reviewRouter.get("/", controller.list)

// BuyerAuth — ตรวจสิทธิ์รีวิวก่อน submit form
reviewRouter.get("/check", BuyerAuth, controller.checkReviewable)

// BuyerAuth — สร้างรีวิวพร้อมรูปสูงสุด 5 รูป
reviewRouter.post("/", BuyerAuth, upload.array("images", 5), controller.create)
reviewRouter.get("/featured", controller.featured)