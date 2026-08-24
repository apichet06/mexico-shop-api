import type { Request, Response } from "express";
import { ApiError } from "../../shared/errors/ApiError.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as service from "./analytics.service.js";
import type { WebsiteAnalyticsEventInput, WebsiteAnalyticsEventName } from "./analytics.type.js";
import type { WebsiteAnalyticsRange } from "./analytics.type.js";

const VALID_WEBSITE_KEYS = new Set(["arcana", "deadstock", "combined"]);
const VALID_EVENT_NAMES = new Set<WebsiteAnalyticsEventName>([
    "page_view",
    "product_view",
    "coupon_view",
    "coupon_collect",
    "cart_view",
    "add_to_cart",
    "checkout_start",
    "order_success",
]);
const VALID_RANGES = new Set<WebsiteAnalyticsRange>(["today", "7d", "30d", "90d"]);

function stringField(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new ApiError(400, `${field} ไม่ถูกต้อง`);
    }
    return value.trim().slice(0, maxLength);
}

function nullableStringField(value: unknown, maxLength: number): string | null {
    if (value == null || value === "") return null;
    if (typeof value !== "string") return null;
    return value.trim().slice(0, maxLength) || null;
}

function safeDecodeUrl(value: string): string {
    try {
        return decodeURI(value);
    } catch {
        return value;
    }
}

function urlStringField(value: unknown, field: string, maxLength: number): string {
    return safeDecodeUrl(stringField(value, field, maxLength));
}

function nullableUrlStringField(value: unknown, maxLength: number): string | null {
    const text = nullableStringField(value, maxLength);
    return text ? safeDecodeUrl(text) : null;
}

function nullableNumberField(value: unknown): number | null {
    if (value == null || value === "") return null;
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function nullableDateField(value: unknown, field: string): string | undefined {
    if (value == null || value === "") return undefined;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new ApiError(400, `${field} ต้องอยู่ในรูปแบบ YYYY-MM-DD`);
    }
    return value;
}

function getDateDiffDays(startDate: string, endDate: string) {
    const start = new Date(`${startDate}T00:00:00`);
    const end = new Date(`${endDate}T00:00:00`);
    return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function parseEventInput(body: Record<string, unknown>): WebsiteAnalyticsEventInput {
    const websiteKey = stringField(body.website_key, "website_key", 32);
    const eventName = stringField(body.event_name, "event_name", 64) as WebsiteAnalyticsEventName;

    if (!VALID_WEBSITE_KEYS.has(websiteKey)) {
        throw new ApiError(400, "website_key ต้องเป็น arcana, deadstock หรือ combined");
    }
    if (!VALID_EVENT_NAMES.has(eventName)) {
        throw new ApiError(400, "event_name ไม่อยู่ในรายการที่รองรับ");
    }

    return {
        website_key: websiteKey as WebsiteAnalyticsEventInput["website_key"],
        event_name: eventName,
        visitor_id: stringField(body.visitor_id, "visitor_id", 128),
        session_id: stringField(body.session_id, "session_id", 128),
        user_id: nullableNumberField(body.user_id),
        path: urlStringField(body.path, "path", 512),
        referrer: nullableUrlStringField(body.referrer, 512),
        product_id: nullableNumberField(body.product_id),
        coupon_id: nullableNumberField(body.coupon_id),
        order_id: nullableNumberField(body.order_id),
        metadata: typeof body.metadata === "object" && body.metadata !== null && !Array.isArray(body.metadata)
            ? body.metadata as Record<string, unknown>
            : null,
    };
}

export const recordEvent = asyncHandler(async (req: Request, res: Response) => {
    const input = parseEventInput(req.body ?? {});
    const forwardedFor = req.headers["x-forwarded-for"];
    const ip = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor ?? req.ip;

    await service.recordEvent(input, {
        ip: ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
    });

    // 204 ทำให้ frontend ยิงแบบ fire-and-forget ได้ ไม่ต้อง parse response body
    res.status(204).send();
});

export const getAdminReport = asyncHandler(async (req: Request, res: Response) => {
    const websiteKey = stringField(req.query.website_key, "website_key", 32);
    const range = (typeof req.query.range === "string" ? req.query.range : "7d") as WebsiteAnalyticsRange;
    const startDate = nullableDateField(req.query.start_date, "start_date");
    const endDate = nullableDateField(req.query.end_date, "end_date");

    if (!VALID_WEBSITE_KEYS.has(websiteKey)) {
        throw new ApiError(400, "website_key ต้องเป็น arcana, deadstock หรือ combined");
    }
    if (!VALID_RANGES.has(range)) {
        throw new ApiError(400, "range ต้องเป็น today, 7d, 30d หรือ 90d");
    }
    if (startDate && endDate && startDate > endDate) {
        throw new ApiError(400, "start_date ต้องไม่มากกว่า end_date");
    }
    if (startDate && endDate && getDateDiffDays(startDate, endDate) > 366) {
        throw new ApiError(400, "เลือกช่วงวันที่ได้ไม่เกิน 366 วัน");
    }

    const report = await service.getAdminReport({
        websiteKey: websiteKey as WebsiteAnalyticsEventInput["website_key"],
        range,
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
    });

    res.json({ data: report });
});
