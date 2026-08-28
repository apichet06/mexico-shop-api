import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as optionType from "./optionType.service.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";

function parseInput(body: unknown) {
    const value = (body ?? {}) as Record<string, unknown>;
    const otype_code = String(value.otype_code ?? "").trim().toUpperCase();
    const otype_name = String(value.otype_name ?? "").trim();

    if (!otype_code) throw new ApiError(400, "Introduce el código del tipo de opción.");
    if (otype_code.length > 45) throw new ApiError(400, "El código no puede superar los 45 caracteres.");
    if (!/^[A-Z0-9_-]+$/.test(otype_code)) {
        throw new ApiError(400, "El código solo puede contener letras, números, guiones y guiones bajos.");
    }
    if (!otype_name) throw new ApiError(400, "Introduce el nombre del tipo de opción.");
    if (otype_name.length > 45) throw new ApiError(400, "El nombre no puede superar los 45 caracteres.");

    return { otype_code, otype_name };
}

function parseId(value: string | string[] | undefined) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, "El identificador del tipo de opción no es válido.");
    return id;
}

function parseLanguage(value: unknown) {
    return typeof value === "string" && ["es", "en", "ja", "th"].includes(value) ? value : "es";
}

export const getlist = asyncHandler(async (_req, res) => {
    const data = await optionType.List();
    res.status(200).json({ data });
});

export const getListByLanguage = asyncHandler(async (req, res) => {
    const data = await optionType.List(parseLanguage(req.params.lang));
    res.status(200).json({ data });
});

export const create = asyncHandler(async (req, res) => {
    const otype_id = await optionType.Create(parseInput(req.body));
    res.status(201).json({ message: CommonMessages.insertSuccess, data: { otype_id } });
});

export const update = asyncHandler(async (req, res) => {
    await optionType.Update(parseId(req.params.otype_id), parseInput(req.body));
    res.status(200).json({ message: CommonMessages.updateSuccess });
});

export const remove = asyncHandler(async (req, res) => {
    await optionType.Delete(parseId(req.params.otype_id));
    res.status(200).json({ message: CommonMessages.deleteSuccess });
});
