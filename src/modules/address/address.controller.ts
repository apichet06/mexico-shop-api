import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import *  as provinceService from "./address.service.js";

export const listProvinces = asyncHandler(async (_req, res) => {
    const data = await provinceService.listProvinces();
    res.status(200).json({ data });
});

export const listDistricts = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await provinceService.listDistricts(Number(id));
    res.status(200).json({ data });
});

export const listSubDistricts = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await provinceService.listSubDistricts(Number(id));
    res.status(200).json({ data });
});