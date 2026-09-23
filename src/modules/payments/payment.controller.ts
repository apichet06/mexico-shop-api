import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import * as service from "./payment.service.js";

export const createConektaCheckout = asyncHandler(async (req, res) => {
    const uId = req.userId;
    const orderIds = Array.isArray(req.body?.order_ids) ? req.body.order_ids.map(Number) : [];
    if (!uId) throw new ApiError(401, "No se encontró la información del usuario."); // "ไม่พบข้อมูลผู้ใช้"
    if (!orderIds.length) throw new ApiError(400, "order_ids debe ser un array y no puede estar vacío."); // "order_ids ต้องเป็น array และไม่ว่าง"

    const payment = await service.createConektaCheckout({
        u_id: uId,
        order_ids: orderIds,
        payment_method: "conekta",
    });
    res.status(200).json({ data: payment });
});

export const syncConektaPayment = asyncHandler(async (req, res) => {
    const uId = req.userId;
    const orderIds = Array.isArray(req.body?.order_ids) ? req.body.order_ids.map(Number) : [];
    if (!uId) throw new ApiError(401, "No se encontró la información del usuario."); // "ไม่พบข้อมูลผู้ใช้"
    if (!orderIds.length) throw new ApiError(400, "order_ids debe ser un array y no puede estar vacío."); // "order_ids ต้องเป็น array และไม่ว่าง"

    const payment = await service.syncConektaPayment(uId, orderIds);
    res.status(200).json({ data: payment });
});
