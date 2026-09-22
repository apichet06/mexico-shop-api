import { Router } from "express";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import {
    handleConektaOrder,
    verifyConektaWebhookSignature,
} from "../payments/payment.service.js";
import { handleSkydropxWebhook, verifySkydropxWebhook } from "../shipping/shipping.webhook.js";

export const webhookRouter = Router();

webhookRouter.post("/conekta", asyncHandler(async (req, res) => {
    const digest = typeof req.headers.digest === "string" ? req.headers.digest : undefined;
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
    if (!verifyConektaWebhookSignature(rawBody, digest)) {
        throw new ApiError(401, "Invalid Conekta webhook signature");
    }
    if (req.body?.type === "order.paid" || req.body?.type === "order.pending_payment") {
        const orderId = req.body?.data?.object?.id;
        if (typeof orderId === "string") await handleConektaOrder(orderId);
    }
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
