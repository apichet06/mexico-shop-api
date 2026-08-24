
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as productaddstock from "./product-addstock.service.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
export const list = asyncHandler(async (req, res) => {
    const { st_id, log_code } = req.params;
    const data = await productaddstock.list(Number(st_id), String(log_code));
    res.status(200).json({ data });

})

export const addStock = asyncHandler(async (req, res) => {
    const { pv_id, loc_id, addOn_hand } = req.body;
    const empId = Number(req.empId);
    const storeId = Number(req.storeId);
    const data = await productaddstock.addStock({ pv_id, loc_id, addOn_hand, e_id: empId, st_id: storeId });

    res.status(200).json({ message: CommonMessages.insertSuccess, data });

})
export const reduceStock = asyncHandler(async (req, res) => {
    const { pv_id, loc_id, reduceOn_hand } = req.body;
    const empId = Number(req.empId);
    const storeId = Number(req.storeId);
    const data = await productaddstock.reduceStock({ pv_id, loc_id, reduceOn_hand, e_id: empId, st_id: storeId });
    res.status(200).json({ message: CommonMessages.updateSuccess, data });
})

export const ListInventoryLog = asyncHandler(async (req, res) => {
    const { st_id, inv_id } = req.params;
    const data = await productaddstock.ListInventoryLog(Number(st_id), Number(inv_id));
    res.status(200).json({ data });

})

export const ListInventoryMovement = asyncHandler(async (req, res) => {
    const { st_id, log_code } = req.params;
    const data = await productaddstock.ListInventoryMovement(Number(st_id), String(log_code));
    res.status(200).json({ data });
})

export const ListInactiveStock = asyncHandler(async (req, res) => {
    const { st_id, log_code } = req.params;
    const days = Number(req.query.days ?? 60);
    const data = await productaddstock.ListInactiveStock(Number(st_id), String(log_code), days);
    res.status(200).json({ data });
})
