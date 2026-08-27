import { CommonMessages } from "../../shared/messages/common.messages.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";

import * as brands from "./brands.service.js";

export const list = asyncHandler(async (_req, res) => {
    const data = await brands.listBrands();
    res.status(200).json({ data });
});

export const create = asyncHandler(async (req, res) => {
    const { b_name } = req.body;
    await brands.createBrand({ b_name, e_id: Number(req.empId) });
    res.status(201).json({ message: CommonMessages.insertSuccess });
});

export const update = asyncHandler(async (req, res) => {
    const { b_name } = req.body;
    const { b_id } = req.params;
    await brands.updateBrand(Number(b_id), { b_name });
    res.status(200).json({ message: CommonMessages.updateSuccess });
});
export const deleteBrand = asyncHandler(async (req, res) => {
    const { b_id } = req.params;
    await brands.deleteBrand(Number(b_id));
    res.status(200).json({ message: CommonMessages.deleteSuccess });
});
