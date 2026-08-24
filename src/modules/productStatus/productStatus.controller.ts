import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import * as  productStatus from "./productStatus.service.js"

export const List = asyncHandler(async (req, res) => {
    const data = await productStatus.list();
    res.status(200).json({ data });
});


