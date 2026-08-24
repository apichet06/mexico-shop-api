import { CommonMessages } from "../../shared/messages/common.messages.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";

import * as brands from "./brands.service.js";

export const list = asyncHandler(async (_req, res) => {
    const data = await brands.listBrands();
    res.status(200).json({ data });
});

export const create = asyncHandler(async (req, res) => {
    const { b_name, ctl_id } = req.body;
    await brands.createBrand({ b_name, ctl_id: Number(ctl_id), e_id: 1 });
    res.status(201).json({ message: CommonMessages.insertSuccess });
});

export const update = asyncHandler(async (req, res) => {
    const { b_name, ctl_id } = req.body;
    const { b_id } = req.params;
    await brands.updateBrand(Number(b_id), { b_name, ctl_id: Number(ctl_id) });
    res.status(200).json({ message: CommonMessages.updateSuccess });
});
export const deleteBrand = asyncHandler(async (req, res) => {
    const { b_id } = req.params;
    await brands.deleteBrand(Number(b_id));
    res.status(200).json({ message: CommonMessages.deleteSuccess });
});
