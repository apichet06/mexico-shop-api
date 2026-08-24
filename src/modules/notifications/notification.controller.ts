import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as notification from "./notification.service.js";


export const list = asyncHandler(async (_req, res) => {
    const { st_id } = _req.params
    const data = await notification.ListNotification(Number(st_id));
    res.status(200).json({ data });
})

export const listBuyer = asyncHandler(async (req, res) => {
    const userId = Number(req.userId);
    const data = await notification.ListBuyerNotification(userId);
    res.status(200).json({ data });
})

export const markAsRead = asyncHandler(async (_req, res) => {
    const { noti_id } = _req.params
    const data = await notification.UpdateAsRead(Number(noti_id));
    res.status(200).json({ data });
})

export const markBuyerAsRead = asyncHandler(async (req, res) => {
    const { noti_id } = req.params
    const data = await notification.UpdateBuyerAsRead(Number(noti_id), Number(req.userId));
    res.status(200).json({ data });
})

export const markAllAsRead = asyncHandler(async (_req, res) => {
    const { st_id } = _req.params
    const data = await notification.UpdateAllRead(Number(st_id));
    res.status(200).json({ data });

})

export const markBuyerAllAsRead = asyncHandler(async (req, res) => {
    const data = await notification.UpdateBuyerAllRead(Number(req.userId));
    res.status(200).json({ data });
})
