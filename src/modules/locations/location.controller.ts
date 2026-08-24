
import * as locations from "./location.service.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";

export const list = asyncHandler(async (req, res) => {
    const data = await locations.ListLocations();
    res.status(200).json({ data });
});

export const getById = asyncHandler(async (req, res) => {
    const { st_id } = req.params;
    const data = await locations.getLocationById(Number(st_id));
    if (!data) {
        return res.status(404).json({ message: CommonMessages.notFound });
    }
    res.status(200).json({ data });
});


export const create = asyncHandler(async (req, res) => {
    const { st_id, Subdistricts_id, Districts_id, Provinces_id, loc_address, zip_code, is_default } = req.body;
    const input = { st_id, Subdistricts_id, Districts_id, Provinces_id, loc_address, zip_code, is_default };
    const id = await locations.CreateLocation(input);
    res.status(201).json({ message: CommonMessages.insertSuccess, id });
});

export const update = asyncHandler(async (req, res) => {
    const { loc_id } = req.params;
    const { st_id, Subdistricts_id, Districts_id, Provinces_id, loc_address, zip_code, is_default } = req.body;
    const input = { st_id, Subdistricts_id, Districts_id, Provinces_id, loc_address, zip_code, is_default };
    await locations.UpdateLocation(Number(loc_id), input);
    res.status(200).json({ message: CommonMessages.updateSuccess });
});

export const deleteLocation = asyncHandler(async (req, res) => {
    const { loc_id } = req.params;
    await locations.DeleteLocation(Number(loc_id));
    res.status(200).json({ message: CommonMessages.deleteSuccess });
});
