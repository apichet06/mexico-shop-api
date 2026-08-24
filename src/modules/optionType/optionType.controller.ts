import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as optionType from "./optionType.service.js";

export const getlist = asyncHandler(async (_req, res) => {
    const data = await optionType.List();
    res.status(200).json({ data });
})
