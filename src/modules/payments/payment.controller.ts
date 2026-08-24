import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import * as service from "./payment.service.js";
import type { OmiseChargeInput } from "./payment.type.js";

function normalizePaymentMethod(value: unknown): OmiseChargeInput["payment_method"] {
    if (
        value === "card" ||
        value === "promptpay" ||
        value === "mobile_banking_kbank" ||
        value === "mobile_banking_scb"
    ) {
        return value;
    }
    return "card";
}

export const chargeOmise = asyncHandler(async (req, res) => {
    const uId = req.userId;
    const { order_ids, payment_method, omise_token, omise_source, saved_payment_method_id, save_card } = req.body ?? {};

    if (!uId) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!Array.isArray(order_ids)) throw new ApiError(400, "order_ids ต้องเป็น array");

    const input = {
        u_id: uId,
        order_ids,
        payment_method: normalizePaymentMethod(payment_method),
        ...(omise_token ? { omise_token: String(omise_token) } : {}),
        ...(omise_source ? { omise_source: String(omise_source) } : {}),
        ...(saved_payment_method_id ? { saved_payment_method_id: Number(saved_payment_method_id) } : {}),
        ...(save_card ? { save_card: true } : {}),
    } as const;

    const payment = await service.chargeOrdersWithOmise(input);

    res.status(200).json({ data: payment });
});

export const syncPromptPayCharge = asyncHandler(async (req, res) => {
    const uId = req.userId;
    const body = req.body as Record<string, unknown>;
    const orderIds = Array.isArray(body.order_ids) ? body.order_ids.map(Number) : [];

    if (!uId) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (orderIds.length === 0) throw new ApiError(400, "order_ids ต้องเป็น array และไม่ว่าง");

    const payment = await service.syncPromptPayCharge(uId, orderIds);
    res.status(200).json({ data: payment });
});

export const listPaymentMethods = asyncHandler(async (req, res) => {
    const uId = req.userId;
    if (!uId) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");

    const methods = await service.listSavedPaymentMethods(uId);
    res.status(200).json({ data: methods });
});

export const addPaymentMethod = asyncHandler(async (req, res) => {
    const uId = req.userId;
    const { omise_token, make_default } = req.body ?? {};

    if (!uId) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!omise_token) throw new ApiError(400, "ไม่พบ token สำหรับบันทึกบัตร");

    const method = await service.addSavedPaymentMethod({
        u_id: uId,
        omise_token: String(omise_token),
        ...(make_default !== undefined ? { make_default: Boolean(make_default) } : {}),
    });

    res.status(201).json({ data: method });
});

export const setDefaultPaymentMethod = asyncHandler(async (req, res) => {
    const uId = req.userId;
    const paymentMethodId = Number(req.params.id);

    if (!uId) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!paymentMethodId || isNaN(paymentMethodId)) throw new ApiError(400, "payment method id ไม่ถูกต้อง");

    const method = await service.setDefaultPaymentMethod(uId, paymentMethodId);
    res.status(200).json({ data: method });
});

export const deletePaymentMethod = asyncHandler(async (req, res) => {
    const uId = req.userId;
    const paymentMethodId = Number(req.params.id);

    if (!uId) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    if (!paymentMethodId || isNaN(paymentMethodId)) throw new ApiError(400, "payment method id ไม่ถูกต้อง");

    const result = await service.deleteSavedPaymentMethod(uId, paymentMethodId);
    res.status(200).json({ data: result });
});
