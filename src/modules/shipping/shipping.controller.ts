import { ApiError } from "../../shared/errors/ApiError.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as service from "./shipping.service.js";
import { getShippopLabelHtml, withAutoPrint, withPrintStyles } from "./providers/shippop.js";
import type { CalcType } from "./shipping.type.js";

function parseId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, `${label} ไม่ถูกต้อง`);
  return id;
}

function parsePositiveNumber(value: unknown, label: string): number {
  const n = Number(value);
  if (isNaN(n) || n <= 0) throw new ApiError(400, `${label} ต้องเป็นตัวเลขมากกว่า 0`);
  return n;
}

function parseNonNegNumber(value: unknown, label: string): number {
  const n = Number(value);
  if (isNaN(n) || n < 0) throw new ApiError(400, `${label} ต้องเป็นตัวเลขไม่ติดลบ`);
  return n;
}

function parseCalcType(value: unknown): CalcType {
  if (value !== "WEIGHT_ONLY" && value !== "CHARGEABLE_WEIGHT") {
    throw new ApiError(400, "calc_type ต้องเป็น WEIGHT_ONLY หรือ CHARGEABLE_WEIGHT");
  }
  return value;
}

// ─── Carriers ────────────────────────────────────────────────────────────────

export const listCarriers = asyncHandler(async (_req, res) => {
  const data = await service.listCarriers();
  res.status(200).json({ data });
});

export const createCarrier = asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!body.sc_code) throw new ApiError(400, "จำเป็นต้องระบุ sc_code");
  if (!body.sc_name) throw new ApiError(400, "จำเป็นต้องระบุ sc_name");
  if (!body.calc_type) throw new ApiError(400, "จำเป็นต้องระบุ calc_type");

  const calcType = parseCalcType(body.calc_type);

  const id = await service.createCarrier({
    sc_code: String(body.sc_code).trim(),
    sc_name: String(body.sc_name).trim(),
    shippop_courier_code:
      body.shippop_courier_code !== undefined ? String(body.shippop_courier_code).trim() || null : null,
    calc_type: calcType,
    vol_divisor:
      calcType === "CHARGEABLE_WEIGHT" && body.vol_divisor != null
        ? parsePositiveNumber(body.vol_divisor, "vol_divisor")
        : null,
    tracking_url_template:
      body.tracking_url_template !== undefined ? String(body.tracking_url_template).trim() || null : null,
    is_active: body.is_active !== undefined ? Number(body.is_active) : 1,
  });

  res.status(201).json({ message: "เพิ่มขนส่งสำเร็จ", data: { sc_id: id } });
});

export const updateCarrier = asyncHandler(async (req, res) => {
  const scId = parseId(req.params.sc_id, "sc_id");
  const body = req.body as Record<string, unknown>;

  await service.updateCarrier(scId, {
    ...(body.sc_code !== undefined ? { sc_code: String(body.sc_code).trim() } : {}),
    ...(body.sc_name !== undefined ? { sc_name: String(body.sc_name).trim() } : {}),
    ...(body.shippop_courier_code !== undefined
      ? { shippop_courier_code: String(body.shippop_courier_code).trim() || null }
      : {}),
    ...(body.calc_type !== undefined ? { calc_type: parseCalcType(body.calc_type) } : {}),
    ...(body.vol_divisor !== undefined
      ? {
        vol_divisor:
          body.vol_divisor === null ? null : parsePositiveNumber(body.vol_divisor, "vol_divisor"),
      }
      : {}),
    ...(body.tracking_url_template !== undefined
      ? { tracking_url_template: String(body.tracking_url_template).trim() || null }
      : {}),
    ...(body.is_active !== undefined ? { is_active: Number(body.is_active) } : {}),
  });

  res.status(200).json({ message: "อัปเดตข้อมูลขนส่งสำเร็จ" });
});

export const toggleCarrier = asyncHandler(async (req, res) => {
  const scId = parseId(req.params.sc_id, "sc_id");
  await service.toggleCarrierActive(scId);
  res.status(200).json({ message: "อัปเดตสถานะขนส่งสำเร็จ" });
});

export const deleteCarrier = asyncHandler(async (req, res) => {
  const scId = parseId(req.params.sc_id, "sc_id");
  await service.deleteCarrier(scId);
  res.status(200).json({ message: "ลบขนส่งสำเร็จ" });
});

// ─── Rates ────────────────────────────────────────────────────────────────────

export const listRates = asyncHandler(async (req, res) => {
  const scId = parseId(req.query.sc_id, "sc_id");
  const data = await service.listRates(scId);
  res.status(200).json({ data });
});

export const createRate = asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (body.sc_id == null) throw new ApiError(400, "จำเป็นต้องระบุ sc_id");
  if (!body.zone_code) throw new ApiError(400, "จำเป็นต้องระบุ zone_code");
  if (body.weight_from == null) throw new ApiError(400, "จำเป็นต้องระบุ weight_from");
  if (body.weight_to == null) throw new ApiError(400, "จำเป็นต้องระบุ weight_to");
  if (body.sr_price == null) throw new ApiError(400, "จำเป็นต้องระบุ sr_price");

  const id = await service.createRate({
    sc_id: parseId(body.sc_id, "sc_id"),
    zone_code: String(body.zone_code).trim(),
    weight_from: parseNonNegNumber(body.weight_from, "weight_from"),
    weight_to: parsePositiveNumber(body.weight_to, "weight_to"),
    sr_price: parsePositiveNumber(body.sr_price, "sr_price"),
  });

  res.status(201).json({ message: "เพิ่มอัตราค่าส่งสำเร็จ", data: { sr_id: id } });
});

export const updateRate = asyncHandler(async (req, res) => {
  const srId = parseId(req.params.sr_id, "sr_id");
  const body = req.body as Record<string, unknown>;

  await service.updateRate(srId, {
    ...(body.zone_code !== undefined ? { zone_code: String(body.zone_code).trim() } : {}),
    ...(body.weight_from !== undefined
      ? { weight_from: parseNonNegNumber(body.weight_from, "weight_from") }
      : {}),
    ...(body.weight_to !== undefined
      ? { weight_to: parsePositiveNumber(body.weight_to, "weight_to") }
      : {}),
    ...(body.sr_price !== undefined
      ? { sr_price: parsePositiveNumber(body.sr_price, "sr_price") }
      : {}),
  });

  res.status(200).json({ message: "อัปเดตอัตราค่าส่งสำเร็จ" });
});

export const deleteRate = asyncHandler(async (req, res) => {
  const srId = parseId(req.params.sr_id, "sr_id");
  await service.deleteRate(srId);
  res.status(200).json({ message: "ลบอัตราค่าส่งสำเร็จ" });
});

// ─── Zone Rules ───────────────────────────────────────────────────────────────

export const listZoneRules = asyncHandler(async (req, res) => {
  const scId = parseId(req.query.sc_id, "sc_id");
  const data = await service.listZoneRules(scId);
  res.status(200).json({ data });
});

export const createZoneRule = asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (body.sc_id == null) throw new ApiError(400, "จำเป็นต้องระบุ sc_id");
  if (!body.zone_code) throw new ApiError(400, "จำเป็นต้องระบุ zone_code");
  if (body.postcode_from == null) throw new ApiError(400, "จำเป็นต้องระบุ postcode_from");
  if (body.postcode_to == null) throw new ApiError(400, "จำเป็นต้องระบุ postcode_to");
  if (body.priority == null) throw new ApiError(400, "จำเป็นต้องระบุ priority");

  const id = await service.createZoneRule({
    sc_id: parseId(body.sc_id, "sc_id"),
    zone_code: String(body.zone_code).trim(),
    postcode_from: parseId(body.postcode_from, "postcode_from"),
    postcode_to: parseId(body.postcode_to, "postcode_to"),
    priority: parsePositiveNumber(body.priority, "priority"),
    is_active: body.is_active !== undefined ? Number(body.is_active) : 1,
  });

  res.status(201).json({ message: "เพิ่มกฎโซนสำเร็จ", data: { pzr_id: id } });
});

export const updateZoneRule = asyncHandler(async (req, res) => {
  const pzrId = parseId(req.params.pzr_id, "pzr_id");
  const body = req.body as Record<string, unknown>;

  await service.updateZoneRule(pzrId, {
    ...(body.zone_code !== undefined ? { zone_code: String(body.zone_code).trim() } : {}),
    ...(body.postcode_from !== undefined
      ? { postcode_from: parseId(body.postcode_from, "postcode_from") }
      : {}),
    ...(body.postcode_to !== undefined
      ? { postcode_to: parseId(body.postcode_to, "postcode_to") }
      : {}),
    ...(body.priority !== undefined
      ? { priority: parsePositiveNumber(body.priority, "priority") }
      : {}),
    ...(body.is_active !== undefined ? { is_active: Number(body.is_active) } : {}),
  });

  res.status(200).json({ message: "อัปเดตกฎโซนสำเร็จ" });
});

export const deleteZoneRule = asyncHandler(async (req, res) => {
  const pzrId = parseId(req.params.pzr_id, "pzr_id");
  await service.deleteZoneRule(pzrId);
  res.status(200).json({ message: "ลบกฎโซนสำเร็จ" });
});

// ─── Calculator ───────────────────────────────────────────────────────────────

export const calculateShipping = asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!body.postcode) throw new ApiError(400, "จำเป็นต้องระบุ postcode");
  if (body.weight_g == null) throw new ApiError(400, "จำเป็นต้องระบุ weight_g");

  const input = {
    postcode: String(body.postcode).trim(),
    weight_g: parsePositiveNumber(body.weight_g, "weight_g"),
    ...(body.origin_postcode ? { origin_postcode: String(body.origin_postcode).trim() } : {}),
    ...(body.volume_cm3 != null ? { volume_cm3: Number(body.volume_cm3) } : {}),
    ...(body.length_cm != null ? { length_cm: Number(body.length_cm) } : {}),
    ...(body.width_cm != null ? { width_cm: Number(body.width_cm) } : {}),
    ...(body.height_cm != null ? { height_cm: Number(body.height_cm) } : {}),
  };

  const data = await service.calculateShipping(input);

  res.status(200).json({ data });
});

export const openShippopLabel = asyncHandler(async (req, res) => {
  const trackingCode = String(req.params.tracking_code ?? "").trim();
  const size = String(req.query.size ?? "A6").trim();
  const signature = String(req.query.sig ?? "").trim();
  const autoPrint = String(req.query.print ?? "") === "1";

  const labelHtml = await getShippopLabelHtml(trackingCode, size, signature);
  const html = autoPrint ? withAutoPrint(labelHtml) : withPrintStyles(labelHtml);
  res
    .status(200)
    .setHeader("Content-Type", "text/html; charset=utf-8")
    .setHeader(
      "Content-Security-Policy",
      "default-src 'self' https: data:; img-src 'self' https: data:; style-src 'self' https: 'unsafe-inline'; font-src 'self' https: data:; script-src 'self' 'unsafe-inline';"
    )
    .send(html);
});
