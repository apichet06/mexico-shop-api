import { Router } from "express"
import multer from "multer"
import { BuyerAuth } from "../../shared/middlewares/buyerAuth.js"
import * as controller from "./reviews.controller.js"

// Las imágenes de la reseña se guardan en memory (igual que la imagen del product) (รูปรีวิวเก็บใน memory (เหมือนกับ product image))
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

export const reviewRouter = Router()

// Public — ver las reseñas del producto (ดูรีวิวของสินค้า)
reviewRouter.get("/", controller.list)

// BuyerAuth — verifica el permiso de reseña antes de enviar el form (ตรวจสิทธิ์รีวิวก่อน submit form)
reviewRouter.get("/check", BuyerAuth, controller.checkReviewable)

// BuyerAuth — crea la reseña con un máximo de 5 imágenes (สร้างรีวิวพร้อมรูปสูงสุด 5 รูป)
reviewRouter.post("/", BuyerAuth, upload.array("images", 5), controller.create)
reviewRouter.get("/featured", controller.featured)