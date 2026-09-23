export type ReviewDTO = {
    ed_id: number
    pv_id: number
    oi_id: number
    u_id: number
    u_username: string
    u_avatar: string | null
    massages: string        // Texto de la reseña (ข้อความรีวิว)
    delivery_score: number  // Calificación de envío 1-5 (คะแนนการจัดส่ง 1-5)
    product_score: number   // Calificación del producto 1-5 (คะแนนสินค้า 1-5)
    create_at: string
    images: string[]        // url de las imágenes adjuntas (url รูปภาพประกอบ)
}

export type CreateReviewInput = {
    u_id: number
    pv_id: number
    oi_id: number
    massages: string
    delivery_score: number
    product_score: number
    imageFiles: Express.Multer.File[]
}

export type ReviewSummary = {
    total: number
    avg_product_score: number
    avg_delivery_score: number
}
