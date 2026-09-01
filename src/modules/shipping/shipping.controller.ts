import { ApiError } from "../../shared/errors/ApiError.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as service from "./shipping.service.js";
import type { CalcType } from "./shipping.type.js";

function id(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ApiError(400, `${label} no es válido`);
  return parsed;
}

function calcType(value: unknown): CalcType {
  if (value !== "WEIGHT_ONLY" && value !== "CHARGEABLE_WEIGHT") throw new ApiError(400, "calc_type no es válido.");
  return value;
}

export const listCarriers = asyncHandler(async (_req, res) => {
  res.status(200).json({ data: await service.listCarriers() });
});
export const createCarrier = asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!body.sc_code || !body.sc_name || !body.provider_code || !body.calc_type) throw new ApiError(400, "Los datos del transportista están incompletos.");
  const carrierId = await service.createCarrier({
    sc_code: String(body.sc_code),
    sc_name: String(body.sc_name),
    provider_code: String(body.provider_code),
    calc_type: calcType(body.calc_type),
    vol_divisor: body.vol_divisor == null ? null : Number(body.vol_divisor),
    tracking_url_template: body.tracking_url_template == null ? null : String(body.tracking_url_template),
    is_active: body.is_active == null ? 1 : Number(body.is_active),
  });
  res.status(201).json({ message: "El transportista se agregó con éxito.", data: { sc_id: carrierId } });
});

export const updateCarrier = asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  await service.updateCarrier(id(req.params.sc_id, "sc_id"), {
    ...(body.sc_code !== undefined ? { sc_code: String(body.sc_code) } : {}),
    ...(body.sc_name !== undefined ? { sc_name: String(body.sc_name) } : {}),
    ...(body.provider_code !== undefined ? { provider_code: String(body.provider_code) } : {}),
    ...(body.calc_type !== undefined ? { calc_type: calcType(body.calc_type) } : {}),
    ...(body.vol_divisor !== undefined ? { vol_divisor: body.vol_divisor == null ? null : Number(body.vol_divisor) } : {}),
    ...(body.tracking_url_template !== undefined ? { tracking_url_template: body.tracking_url_template == null ? null : String(body.tracking_url_template) } : {}),
    ...(body.is_active !== undefined ? { is_active: Number(body.is_active) } : {}),
  });
  res.status(200).json({ message: "La información del transportista se actualizó con éxito." });
});

export const toggleCarrier = asyncHandler(async (req, res) => {
  await service.toggleCarrierActive(id(req.params.sc_id, "sc_id"));
  res.status(200).json({ message: "El estado del transportista se actualizó con éxito." });
});

export const deleteCarrier = asyncHandler(async (req, res) => {
  await service.deleteCarrier(id(req.params.sc_id, "sc_id"));
  res.status(200).json({ message: "El transportista se eliminó con éxito." });
});

export const calculateShipping = asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const data = await service.calculateShipping({
    postcode: String(body.postcode ?? ""),
    origin_postcode: String(body.origin_postcode ?? ""),
    weight_g: Number(body.weight_g),
    ...(body.length_cm != null ? { length_cm: Number(body.length_cm) } : {}),
    ...(body.width_cm != null ? { width_cm: Number(body.width_cm) } : {}),
    ...(body.height_cm != null ? { height_cm: Number(body.height_cm) } : {}),
    ...(body.origin_address ? { origin_address: String(body.origin_address) } : {}),
    ...(body.origin_province ? { origin_province: String(body.origin_province) } : {}),
    ...(body.origin_district ? { origin_district: String(body.origin_district) } : {}),
    ...(body.origin_subdistrict ? { origin_subdistrict: String(body.origin_subdistrict) } : {}),
    ...(body.destination_address ? { destination_address: String(body.destination_address) } : {}),
    ...(body.destination_province ? { destination_province: String(body.destination_province) } : {}),
    ...(body.destination_district ? { destination_district: String(body.destination_district) } : {}),
    ...(body.destination_subdistrict ? { destination_subdistrict: String(body.destination_subdistrict) } : {}),
  });
  res.status(200).json({ data });
});
