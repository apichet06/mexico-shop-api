import { CommonMessages } from "../../shared/messages/common.messages.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as unit from "./units.service.js";


export const list = asyncHandler(async (_req, res) => {

    const data = await unit.ListUnit();
    res.status(200).json({ data });

});
export const listByLang = asyncHandler(async (_req, res) => {
    const { lang } = _req.params;
    const data = await unit.GetUnitByLang(lang as string);
    res.status(200).json({ data });

});
export const create = asyncHandler(async (req, res) => {
    const { ul_name } = req.body;
    const empId = Number(req.empId);
    await unit.CreateUnit({
        e_id: empId,
        ul_name
    });
    res.status(201).json({ message: CommonMessages.insertSuccess });
});

export const update = asyncHandler(async (req, res) => {
    const { ul_name } = req.body;
    const { ul_id } = req.params;
    await unit.UpdateUnit(Number(ul_id), { ul_name });
    res.status(200).json({ message: CommonMessages.updateSuccess });
});

export const deleteUnit = asyncHandler(async (req, res) => {
    const { u_id } = req.params;
    await unit.DeleteUnit(Number(u_id));
    res.status(200).json({ message: CommonMessages.deleteSuccess });
});



