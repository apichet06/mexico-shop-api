import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import * as service from "./carts.service.js";

function getRequestLanguage(value: unknown): string {
    return typeof value === "string" && ["es", "en", "ja", "th"].includes(value) ? value : "es";
}

export const getCart = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const lg_code = getRequestLanguage(req.query.lg_code);
    if (!u_id) throw new ApiError(401, "No se encontró la información del usuario.");

    const cart = await service.getCart(u_id, lg_code);
    res.status(200).json({ data: cart });
});

export const updateItemQty = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const ci_id = Number(req.params.ci_id);
    const { qty } = req.body ?? {};

    if (!u_id) throw new ApiError(401, "No se encontró la información del usuario.");
    if (!ci_id || isNaN(ci_id)) throw new ApiError(400, "El ci_id no es válido.");
    if (typeof qty !== "number" || qty < 1) throw new ApiError(400, "qty debe ser un número entero mayor que 0.");

    const item = await service.updateCartItemQty({ ci_id, u_id, qty });
    res.status(200).json({ data: item });
});

export const updateItem = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const ci_id = Number(req.params.ci_id);
    const { is_selected } = req.body ?? {};

    if (!u_id) throw new ApiError(401, "No se encontró la información del usuario.");
    if (!ci_id || isNaN(ci_id)) throw new ApiError(400, "El ci_id no es válido.");
    if (is_selected !== 0 && is_selected !== 1) throw new ApiError(400, "is_selected debe ser 0 o 1.");

    const item = await service.updateCartItem({ ci_id, u_id, is_selected });
    res.status(200).json({ data: item });
});

export const addItem = asyncHandler(async (req, res) => {
    const { pv_id, qty } = req.body ?? {};
    const u_id = req.userId;

    if (!u_id) throw new ApiError(401, "No se encontró la información del usuario.");
    if (!pv_id || !qty) throw new ApiError(400, "Se requiere especificar pv_id y qty.");
    if (typeof qty !== "number" || qty < 1) throw new ApiError(400, "qty debe ser un número entero mayor que 0.");

    const item = await service.addCartItem({ u_id, pv_id, qty });
    res.status(201).json({ data: item });
});

export const DeleteItem = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const ci_id = Number(req.params.ci_id);

    if (!u_id) throw new ApiError(401, "No se encontró la información del usuario.");
    if (!ci_id || isNaN(ci_id)) throw new ApiError(400, "El ci_id no es válido.");

    await service.deleteCartItem(ci_id, u_id);
    res.status(200).json({ message: "El producto se eliminó del carrito." });
});
