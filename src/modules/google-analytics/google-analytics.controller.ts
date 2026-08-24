import type { Request, Response } from "express";
import { ApiError } from "../../shared/errors/ApiError.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as service from "./google-analytics.service.js";
import type { GoogleAnalyticsRange } from "./google-analytics.type.js";

const VALID_RANGES = new Set<GoogleAnalyticsRange>(["today", "7d", "30d", "90d"]);

export const getDashboard = asyncHandler(async (req: Request, res: Response) => {
    const range = (typeof req.query.range === "string" ? req.query.range : "7d") as GoogleAnalyticsRange;

    if (!VALID_RANGES.has(range)) {
        throw new ApiError(400, "range ต้องเป็น today, 7d, 30d หรือ 90d");
    }

    const dashboard = await service.getDashboard(range);
    res.json({ data: dashboard });
});
