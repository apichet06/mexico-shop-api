
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js"
import *  as  productTags from "./productTags.service.js"

export const list = asyncHandler(async (_req, res) => {
    const { lg_code } = _req.params;
    const data = await productTags.listProductTags(String(lg_code));
    res.status(200).json({ data });
})

export const create = asyncHandler(async (req, res) => {
    const { ptag_name } = req.body;
    const empId = Number(req.empId);
    await productTags.create({
        e_id: empId,
        ptag_name
    });
    res.status(201).json({ message: CommonMessages.insertSuccess });
});

export const update = asyncHandler(async (req, res) => {
    const { ptag_name } = req.body;
    const { ptt_id } = req.params;
    await productTags.update({
        ptag_name,
        ptt_id: Number(ptt_id)
    });
    res.status(200).json({ message: CommonMessages.updateSuccess });
});

export const deleteProductTag = asyncHandler(async (req, res) => {
    const { ptag_id } = req.params;
    await productTags.Delete(Number(ptag_id));
    res.status(200).json({ message: CommonMessages.deleteSuccess });
});