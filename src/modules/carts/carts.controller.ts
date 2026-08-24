import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import * as service from "./carts.service.js";

function getRequestLanguage(value: unknown): string {
    return typeof value === "string" && ["th", "en", "ja"].includes(value) ? value : "th";
}

export const getCart = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const lg_code = getRequestLanguage(req.query.lg_code);
    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");

    const cart = await service.getCart(u_id, lg_code);
    res.status(200).json({ data: cart });
});

export const updateItemQty = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const ci_id = Number(req.params.ci_id);
    const { qty } = req.body ?? {};

    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!ci_id || isNaN(ci_id)) throw new ApiError(400, "ci_id ไม่ถูกต้อง");
    if (typeof qty !== "number" || qty < 1) throw new ApiError(400, "qty ต้องเป็นจำนวนเต็มที่มากกว่า 0");

    const item = await service.updateCartItemQty({ ci_id, u_id, qty });
    res.status(200).json({ data: item });
});

export const updateItem = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const ci_id = Number(req.params.ci_id);
    const { is_selected } = req.body ?? {};

    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!ci_id || isNaN(ci_id)) throw new ApiError(400, "ci_id ไม่ถูกต้อง");
    if (is_selected !== 0 && is_selected !== 1) throw new ApiError(400, "is_selected ต้องเป็น 0 หรือ 1");

    const item = await service.updateCartItem({ ci_id, u_id, is_selected });
    res.status(200).json({ data: item });
});

export const addItem = asyncHandler(async (req, res) => {
    const { pv_id, qty } = req.body ?? {};
    const u_id = req.userId;

    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!pv_id || !qty) throw new ApiError(400, "จำเป็นต้องระบุ pv_id และ qty");
    if (typeof qty !== "number" || qty < 1) throw new ApiError(400, "qty ต้องเป็นจำนวนเต็มที่มากกว่า 0");

    const item = await service.addCartItem({ u_id, pv_id, qty });
    res.status(201).json({ data: item });
});

export const DeleteItem = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const ci_id = Number(req.params.ci_id);

    if (!u_id) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!ci_id || isNaN(ci_id)) throw new ApiError(400, "ci_id ไม่ถูกต้อง");

    await service.deleteCartItem(ci_id, u_id);
    res.status(200).json({ message: "ลบสินค้าออกจากตะกร้าแล้ว" });
});

