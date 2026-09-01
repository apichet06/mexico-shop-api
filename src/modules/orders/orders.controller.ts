import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import type { OrderStatusCode } from "./order-status.service.js";
import * as service from "./orders.service.js";
import type { CheckoutOrderInput, ShippingSelection } from "./type.js";

function normalizePaymentMethod(_value: unknown): CheckoutOrderInput["payment_method"] {
    return "mercado_pago";
}

function getRequestLanguage(value: unknown): string {
    return typeof value === "string" && ["es", "en", "ja", "th"].includes(value) ? value : "es";
}

function normalizeShippingSelections(value: unknown): ShippingSelection[] {
    if (!Array.isArray(value)) return [];

    const byStoreId = new Map<number, number>();
    for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const st_id = Number((entry as Record<string, unknown>).st_id);
        const sc_id = Number((entry as Record<string, unknown>).sc_id);
        if (!Number.isInteger(st_id) || st_id <= 0) continue;
        if (!Number.isInteger(sc_id) || sc_id <= 0) continue;
        byStoreId.set(st_id, sc_id);
    }

    return Array.from(byStoreId.entries()).map(([st_id, sc_id]) => ({ st_id, sc_id }));
}

function normalizeSelectedCartItemIds(value: unknown): number[] {
    const rawItems = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? value.split(",")
            : [];

    return [...new Set(rawItems.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function normalizeRefundItemSelections(value: unknown): { oi_id: number; qty: number }[] {
    if (typeof value !== "string" || !value.trim()) return [];

    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];

    const selections: { oi_id: number; qty: number }[] = [];
    for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        const oi_id = Number((entry as Record<string, unknown>).oi_id);
        const qty = Number((entry as Record<string, unknown>).qty);
        if (!Number.isInteger(oi_id) || oi_id <= 0) continue;
        if (!Number.isInteger(qty) || qty <= 0) continue;
        selections.push({ oi_id, qty });
    }
    return selections;
}

export const createOrder = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const { locb_id, co_code, shipping_selections, selected_ci_ids } = req.body ?? {};

    if (!u_id) throw new ApiError(401, "No se encontró la información del usuario.");
    if (!locb_id) throw new ApiError(400, "Se requiere especificar locb_id (dirección de envío).");

    // co_code เป็น optional: ถ้าไม่ส่งมา checkout จะสร้าง order แบบไม่ใช้คูปอง
    const order = await service.createOrder({
        u_id,
        locb_id,
        co_code: co_code ? String(co_code).trim() : null,
        shipping_selections: normalizeShippingSelections(shipping_selections),
        selected_ci_ids: normalizeSelectedCartItemIds(selected_ci_ids),
    });
    res.status(201).json({ data: order });
});

export const checkoutOrder = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const {
        locb_id,
        co_code,
        shipping_selections,
        payment_method,
        selected_ci_ids,
    } = req.body ?? {};

    if (!u_id) throw new ApiError(401, "No se encontró la información del usuario.");
    if (!locb_id) throw new ApiError(400, "Se requiere especificar locb_id (dirección de envío).");

    const data = await service.checkoutOrder({
        u_id,
        locb_id: Number(locb_id),
        co_code: co_code ? String(co_code).trim() : null,
        shipping_selections: normalizeShippingSelections(shipping_selections),
        payment_method: normalizePaymentMethod(payment_method),
        selected_ci_ids: normalizeSelectedCartItemIds(selected_ci_ids),
    });

    res.status(201).json({ data });
});

export const getShippingOptions = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const locb_id = Number(req.query.locb_id);

    if (!u_id) throw new ApiError(401, "No se encontró la información del usuario.");
    if (!locb_id || isNaN(locb_id)) throw new ApiError(400, "Se requiere especificar locb_id (dirección de envío).");

    const data = await service.getCheckoutShippingOptions({
        u_id,
        locb_id,
        selected_ci_ids: normalizeSelectedCartItemIds(req.query.selected_ci_ids),
    });
    res.status(200).json({ data });
});

export const getOrders = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const lg_code = getRequestLanguage(req.query.lg_code);
    if (!u_id) throw new ApiError(401, "No se encontró la información del usuario.");

    const orders = await service.getOrders(u_id, lg_code);
    res.status(200).json({ data: orders });
});

export const adminGetOrders = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const lg_code = getRequestLanguage(req.query.lg_code);
    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");

    const orders = await service.adminGetOrders(st_id, lg_code);
    res.status(200).json({ data: orders });
});

export const adminGetOrderSummary = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");

    const summary = await service.adminGetOrderSummary(st_id);
    res.status(200).json({ data: summary });
});

export const adminGetSalesReport = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");

    const lg_code = getRequestLanguage(req.query.lg_code);
    const start_date = typeof req.query.start_date === "string" ? req.query.start_date : undefined;
    const end_date = typeof req.query.end_date === "string" ? req.query.end_date : undefined;
    const report = await service.adminGetSalesReport(st_id, {
        lg_code,
        ...(start_date ? { start_date } : {}),
        ...(end_date ? { end_date } : {}),
    });
    res.status(200).json({ data: report });
});

export const adminGetSalesByProductReport = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");

    const lg_code = getRequestLanguage(req.query.lg_code);
    const start_date = typeof req.query.start_date === "string" ? req.query.start_date : undefined;
    const end_date = typeof req.query.end_date === "string" ? req.query.end_date : undefined;
    const report = await service.adminGetSalesByProductReport(st_id, {
        lg_code,
        ...(start_date ? { start_date } : {}),
        ...(end_date ? { end_date } : {}),
    });
    res.status(200).json({ data: report });
});

export const adminGetSalesByCategoryReport = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");

    const lg_code = getRequestLanguage(req.query.lg_code);
    const start_date = typeof req.query.start_date === "string" ? req.query.start_date : undefined;
    const end_date = typeof req.query.end_date === "string" ? req.query.end_date : undefined;
    const report = await service.adminGetSalesByCategoryReport(st_id, {
        lg_code,
        ...(start_date ? { start_date } : {}),
        ...(end_date ? { end_date } : {}),
    });
    res.status(200).json({ data: report });
});

export const adminGetSalesByBuyerReport = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");

    const start_date = typeof req.query.start_date === "string" ? req.query.start_date : undefined;
    const end_date = typeof req.query.end_date === "string" ? req.query.end_date : undefined;
    const report = await service.adminGetSalesByBuyerReport(st_id, {
        ...(start_date ? { start_date } : {}),
        ...(end_date ? { end_date } : {}),
    });
    res.status(200).json({ data: report });
});

export const adminGetOrderById = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);

    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "El or_id no es válido.");

    const order = await service.adminGetOrderById(or_id, st_id, lg_code);
    if (!order) throw new ApiError(404, "No se encontró el pedido.");

    res.status(200).json({ data: order });
});

export const adminApproveRefund = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);
    const note = typeof req.body?.note === "string" ? req.body.note : "";

    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "El or_id no es válido.");

    const order = await service.approveRefundRequest(or_id, st_id, note, lg_code);
    const needsManualRefund = order.refund_status === "failed" && Boolean(order.refund_remark?.includes("transferirse manualmente"));
    res.status(200).json({
        data: order,
        message: needsManualRefund
            ? "Mercado Pago no pudo procesar el reembolso automáticamente. Transfiere el reembolso al cliente manualmente."
            : "Reembolso aprobado con éxito.",
    });
});

export const adminConfirmManualRefund = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);
    const note = typeof req.body?.note === "string" ? req.body.note : "";

    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "El or_id no es válido.");

    const order = await service.confirmManualRefundRequest(or_id, st_id, note, lg_code);
    res.status(200).json({ data: order, message: "Se confirmó la transferencia del reembolso al cliente." });
});

export const adminConfirmReturnReceived = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);
    const note = typeof req.body?.note === "string" ? req.body.note : "";

    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "El or_id no es válido.");

    const order = await service.confirmReturnReceived(or_id, st_id, note, lg_code);
    const needsManualRefund = order.refund_status === "failed" && Boolean(order.refund_remark?.includes("transferirse manualmente"));
    res.status(200).json({
        data: order,
        message: needsManualRefund
            ? "Se recibió el producto devuelto, pero Mercado Pago no pudo procesar el reembolso automáticamente. Transfiere el reembolso al cliente manualmente."
            : "Se confirmó la recepción del producto devuelto y el reembolso se completó con éxito.",
    });
});

export const adminUpdateStatus = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);
    const statusCode = String(req.body?.status_code ?? "");
    const note = typeof req.body?.note === "string" ? req.body.note : "";

    const allowedStatusCodes = ["PROCESSING", "PACKED", "READY_TO_SHIP"];

    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "El or_id no es válido.");
    if (!allowedStatusCodes.includes(statusCode)) throw new ApiError(400, "El estado que deseas cambiar no es válido.");

    const order = await service.adminUpdateOrderStatus(or_id, st_id, statusCode as OrderStatusCode, note, lg_code);
    const message =
        statusCode === "READY_TO_SHIP"
            ? "El pedido está listo para enviar. El envío se creó correctamente y aún puedes editar el número de guía."
            : "El estado del pedido se actualizó con éxito.";
    res.status(200).json({ data: order, message });
});

export const adminUpdateTracking = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);
    const trackingNo = typeof req.body?.tracking_no === "string" ? req.body.tracking_no : "";

    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "El or_id no es válido.");

    const order = await service.adminUpdateOrderTracking(or_id, st_id, trackingNo, lg_code);
    res.status(200).json({ data: order, message: "El número de guía se guardó con éxito." });
});

export const adminCreateShipment = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);

    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "El or_id no es válido.");

    const order = await service.adminCreateOrderShipment(or_id, st_id, lg_code);
    res.status(200).json({
        data: order,
        message: "El pedido está listo para enviar. El envío se creó correctamente y aún puedes editar el número de guía.",
    });
});

export const adminDevMarkDelivered = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);

    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "El or_id no es válido.");

    const order = await service.adminDevMarkOrderDelivered(or_id, st_id, lg_code);
    res.status(200).json({
        data: order,
        message: "Se simuló la entrega con éxito.",
    });
});

export const adminCancelOrder = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";

    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "El or_id no es válido.");
    if (note.length < 3) throw new ApiError(400, "Indica el motivo de la cancelación del pedido.");

    const order = await service.adminCancelOrder(or_id, st_id, note, lg_code);
    const needsManualRefund = order.refund_status === "failed" && Boolean(order.refund_remark?.includes("transferirse manualmente"));
    const message = needsManualRefund
        ? "El pedido se canceló con éxito, pero Mercado Pago no pudo procesar el reembolso automáticamente. Transfiere el reembolso al cliente manualmente."
        : order.refund_status === "succeeded"
            ? "El pedido se canceló y el reembolso se completó con éxito."
            : "El pedido se canceló con éxito.";

    res.status(200).json({ data: order, message });
});

export const adminRejectRefund = asyncHandler(async (req, res) => {
    const st_id = Number(req.storeId);
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);
    const note = typeof req.body?.note === "string" ? req.body.note : "";

    if (!st_id) throw new ApiError(401, "No se encontró la información de la tienda.");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "El or_id no es válido.");

    const order = await service.rejectRefundRequest(or_id, st_id, note, lg_code);
    res.status(200).json({ data: order, message: "Se rechazó la solicitud de reembolso." });
});

export const getOrderById = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);

    if (!u_id) throw new ApiError(401, "No se encontró la información del usuario.");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "El or_id no es válido.");

    const order = await service.getOrderById(or_id, u_id, lg_code);
    if (!order) throw new ApiError(404, "No se encontró el pedido.");

    res.status(200).json({ data: order });
});

export const cancelOrder = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    if (!u_id) throw new ApiError(401, "No se encontró la información del usuario.");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "El or_id no es válido.");
    if (reason.length < 5) throw new ApiError(400, "Indica el motivo de la cancelación del pedido.");

    const order = await service.cancelOrder(or_id, u_id, reason, lg_code);
    res.status(200).json({ data: order, message: "El pedido se canceló con éxito." });
});

export const confirmOrderReceived = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);

    if (!u_id) throw new ApiError(401, "No se encontró la información del usuario.");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "El or_id no es válido.");

    const order = await service.confirmOrderReceived(or_id, u_id, lg_code);
    res.status(200).json({ data: order, message: "Se confirmó la recepción del pedido con éxito." });
});

export const requestRefund = asyncHandler(async (req, res) => {
    const u_id = req.userId;
    const or_id = Number(req.params.or_id);
    const lg_code = getRequestLanguage(req.query.lg_code);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const returnTracking = typeof req.body?.return_tracking === "string" ? req.body.return_tracking.trim() : "";
    const imageFiles = (req.files as Express.Multer.File[]) ?? [];
    const selectedItems = normalizeRefundItemSelections(req.body?.items);

    if (!u_id) throw new ApiError(401, "No se encontró la información del usuario.");
    if (!or_id || isNaN(or_id)) throw new ApiError(400, "El or_id no es válido.");
    if (reason.length < 5) throw new ApiError(400, "Indica el motivo de la solicitud de reembolso.");
    if (imageFiles.length > 3) throw new ApiError(400, "Puedes adjuntar un máximo de 3 fotos.");

    const order = await service.requestRefund(or_id, u_id, reason, lg_code, returnTracking, imageFiles, selectedItems);
    res.status(201).json({ data: order, message: "Se envió la solicitud de reembolso." });
});
