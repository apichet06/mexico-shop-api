import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as statuses from "./statuses.service.js";
import type { UpdateStatusLangInput } from "./statuses.type.js";

export const list = asyncHandler(async (req, res) => {
    const { lg_code } = req.params;
    const data = await statuses.listStatusLangs(String(lg_code));
    res.status(200).json({ data });
});

export const update = asyncHandler(async (req, res) => {
    const { s_id, lg_code } = req.params;
    const input: UpdateStatusLangInput = {
        s_name: String(req.body.s_name ?? "").trim(),
    };

    await statuses.updateStatusLang(Number(s_id), String(lg_code), input);
    res.status(200).json({ message: "อัปเดตสถานะสำเร็จ" });
});
