import { Router } from "express";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import {
    handleMercadoPagoPayment,
    verifyMercadoPagoWebhookSignature,
} from "../payments/payment.service.js";
import { handleSkydropxWebhook, verifySkydropxWebhook } from "../shipping/shipping.webhook.js";

export const webhookRouter = Router();

webhookRouter.post("/mercado-pago", asyncHandler(async (req, res) => {
    const queryDataId = typeof req.query["data.id"] === "string" ? req.query["data.id"] : undefined;
    const bodyDataId = req.body?.data?.id != null ? String(req.body.data.id) : undefined;
    const dataId = queryDataId || bodyDataId;
    const type = typeof req.query.type === "string" ? req.query.type : req.body?.type;
    const xSignature = typeof req.headers["x-signature"] === "string" ? req.headers["x-signature"] : undefined;
    const xRequestId = typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : undefined;

    if (!verifyMercadoPagoWebhookSignature({ xSignature, xRequestId, dataId })) {
        throw new ApiError(401, "Invalid Mercado Pago webhook signature");
    }
    if (type === "payment" && dataId) await handleMercadoPagoPayment(dataId);
    res.status(200).json({ received: true });
}));

webhookRouter.post("/skydropx", asyncHandler(async (req, res) => {
    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    if (!verifySkydropxWebhook(authorization)) {
        throw new ApiError(401, "Invalid Skydropx webhook token");
    }
    const result = await handleSkydropxWebhook(req.body);
    res.status(200).json({ received: true, ...result });
}));
