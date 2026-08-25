import * as locations from "./location.service.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import type { CreateLocationInput } from "./location.type.js";

const FIELD_LIMITS = {
    loc_address: 255,
    colonia: 160,
    municipality: 120,
    city: 120,
    state: 100,
    formatted_address: 500,
} as const;

function parseMexicoLocation(body: Record<string, unknown>): CreateLocationInput {
    const requiredText = (field: keyof typeof FIELD_LIMITS): string => {
        const value = body[field];
        if (typeof value !== "string" || !value.trim()) throw new ApiError(400, `กรุณาระบุ ${field}`);
        if (value.length > FIELD_LIMITS[field]) {
            throw new ApiError(400, `${field} ต้องไม่เกิน ${FIELD_LIMITS[field]} ตัวอักษร`);
        }
        return value.trim();
    };

    const st_id = Number(body.st_id);
    if (!Number.isInteger(st_id) || st_id <= 0) throw new ApiError(400, "รหัสร้านไม่ถูกต้อง");

    if (body.country_code !== "MX") {
        const Provinces_id = Number(body.Provinces_id);
        const Districts_id = Number(body.Districts_id);
        const Subdistricts_id = Number(body.Subdistricts_id);
        if (![Provinces_id, Districts_id, Subdistricts_id].every((value) => Number.isInteger(value) && value > 0)) {
            throw new ApiError(400, "ข้อมูลจังหวัด อำเภอ หรือตำบลไม่ถูกต้อง");
        }
        const loc_address = typeof body.loc_address === "string" ? body.loc_address.trim() : "";
        const zip_code = String(body.zip_code ?? "").trim();
        if (!loc_address || !zip_code) throw new ApiError(400, "กรุณาระบุข้อมูลที่อยู่ให้ครบถ้วน");
        return {
            st_id, loc_address, zip_code,
            Provinces_id, Districts_id, Subdistricts_id,
            country_code: null, colonia: null, municipality: null, city: null, state: null,
            latitude: null, longitude: null, formatted_address: null,
            is_default: body.is_default === true || body.is_default === 1 || body.is_default === "1",
        };
    }

    const zip_code = String(body.zip_code ?? "");
    if (!/^\d{5}$/.test(zip_code)) throw new ApiError(400, "รหัสไปรษณีย์เม็กซิโกต้องมี 5 หลัก");

    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    if (!Number.isFinite(latitude) || latitude < 14 || latitude > 33) {
        throw new ApiError(400, "พิกัด latitude อยู่นอกประเทศเม็กซิโก");
    }
    if (!Number.isFinite(longitude) || longitude < -119 || longitude > -86) {
        throw new ApiError(400, "พิกัด longitude อยู่นอกประเทศเม็กซิโก");
    }

    const rawFormattedAddress = body.formatted_address;
    if (rawFormattedAddress != null && (
        typeof rawFormattedAddress !== "string" || rawFormattedAddress.length > FIELD_LIMITS.formatted_address
    )) {
        throw new ApiError(400, `formatted_address ต้องไม่เกิน ${FIELD_LIMITS.formatted_address} ตัวอักษร`);
    }

    return {
        st_id,
        loc_address: requiredText("loc_address"),
        colonia: requiredText("colonia"),
        municipality: requiredText("municipality"),
        city: requiredText("city"),
        state: requiredText("state"),
        zip_code,
        country_code: "MX",
        latitude,
        longitude,
        formatted_address: typeof rawFormattedAddress === "string" ? rawFormattedAddress.trim() || null : null,
        is_default: body.is_default === true || body.is_default === 1 || body.is_default === "1",
        Provinces_id: null,
        Districts_id: null,
        Subdistricts_id: null,
    };
}

export const list = asyncHandler(async (_req, res) => {
    const data = await locations.ListLocations();
    res.status(200).json({ data });
});

export const getById = asyncHandler(async (req, res) => {
    const data = await locations.getLocationById(Number(req.params.st_id));
    if (!data) return res.status(404).json({ message: CommonMessages.notFound });
    res.status(200).json({ data });
});

export const create = asyncHandler(async (req, res) => {
    const id = await locations.CreateLocation(parseMexicoLocation(req.body ?? {}));
    res.status(201).json({ message: CommonMessages.insertSuccess, id });
});

export const update = asyncHandler(async (req, res) => {
    await locations.UpdateLocation(Number(req.params.loc_id), parseMexicoLocation(req.body ?? {}));
    res.status(200).json({ message: CommonMessages.updateSuccess });
});

export const deleteLocation = asyncHandler(async (req, res) => {
    await locations.DeleteLocation(Number(req.params.loc_id));
    res.status(200).json({ message: CommonMessages.deleteSuccess });
});
