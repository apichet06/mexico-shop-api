import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as catalog from "./catalog.service.js";

export const list = asyncHandler(async (_req, res) => {
    const data = await catalog.listCatalogs();
    res.json({ data });
});