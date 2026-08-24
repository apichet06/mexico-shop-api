
import { ApiError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/index.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as category from "./category.service.js";



export const list = asyncHandler(async (_req, res) => {
    const data = await category.listCategorys();
    res.status(200).json({ data });
});

export const listBylgCode = asyncHandler(async (_req, res) => {
    const { lg_code } = _req.params;
    const ctl_id = _req.query.ctl_id ? Number(_req.query.ctl_id) : undefined;
    const data = await category.getCategoryByLgCode(lg_code as string, ctl_id);
    res.status(200).json({ data });
});

export const create = asyncHandler(async (req, res) => {
    const { cl_name, ctl_id } = req.body
    const empId = Number(req.empId);
    await category.createCategory({
        e_id: empId,
        ctl_id,
        cl_name
    });
    res.status(201).json({ message: CommonMessages.insertSuccess });
});

export const update = asyncHandler(async (req, res) => {
    const { cl_name } = req.body;
    const { cl_id } = req.params;

    await category.updateCategory(Number(cl_id), { cl_name, ctl_id: Number(req.body.ctl_id) });
    res.status(200).json({ message: CommonMessages.updateSuccess });
});

export const deleteCategory = asyncHandler(async (req, res) => {
    const { c_id } = req.params;
    await category.deleteCategory(Number(c_id));
    res.status(200).json({ message: CommonMessages.deleteSuccess });
});

