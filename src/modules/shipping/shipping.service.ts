import { pool } from "../../db/pool.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import type {
  ShippingCarrier,
  ShippingRate,
  PostcodeZoneRule,
  CreateCarrierInput,
  UpdateCarrierInput,
  CreateRateInput,
  UpdateRateInput,
  CreateZoneRuleInput,
  UpdateZoneRuleInput,
  CalculateInput,
  CalculateResult,
  StoreShippingCarrier,
} from "./shipping.type.js";
import { getShippopCarrierPreset, normalizeShippopCourierCode, quoteShippopRates } from "./providers/shippop.js";
import { ensureStoreShippingCarriersTable } from "./shipping.schema.js";

// ─── Carriers ────────────────────────────────────────────────────────────────

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function envMoney(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

let carrierProviderColumnReady: Promise<void> | null = null;

export async function ensureShippingCarrierProviderColumn(): Promise<void> {
  carrierProviderColumnReady ??= pool.query(
    `SELECT COLUMN_NAME AS column_name
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'Shipping_carriers'
       AND COLUMN_NAME = 'shippop_courier_code'`
  )
    .then(async ([columns]) => {
      if ((columns as unknown[]).length === 0) {
        await pool.query(
          "ALTER TABLE Shipping_carriers ADD COLUMN shippop_courier_code VARCHAR(30) NULL AFTER sc_name"
        );
      }
    })
    .then(() => undefined);

  return carrierProviderColumnReady;
}

function resolveShippopCarrierConfig(scCode: string, providerCode?: string | null) {
  const preset = getShippopCarrierPreset(scCode);
  if (!preset) {
    throw new ApiError(400, "ขนส่งนี้ยังไม่อยู่ในรายการที่รองรับ SHIPPOP");
  }

  const expectedProviderCode = normalizeShippopCourierCode(preset.courierCode);
  const actualProviderCode = providerCode?.trim()
    ? normalizeShippopCourierCode(providerCode)
    : expectedProviderCode;

  if (actualProviderCode !== expectedProviderCode) {
    throw new ApiError(400, `รหัส SHIPPOP ของ ${preset.name} ต้องเป็น ${expectedProviderCode}`);
  }

  return { preset, providerCode: expectedProviderCode };
}

function calculateCustomerShippingFee(providerPrice: number): number {
  // providerPrice คือต้นทุนที่ SHIPPOP quote กลับมา
  // ราคาที่คิดลูกค้า = max(ต้นทุน SHIPPOP + SHIPPOP_HANDLING_FEE, SHIPPOP_MIN_CUSTOMER_FEE)
  // เช่น quote 30, handling 10, minimum 40 => ลูกค้าจ่าย 40
  // เช่น quote 53, handling 10, minimum 40 => ลูกค้าจ่าย 63
  const handlingFee = envMoney("SHIPPOP_HANDLING_FEE", 5);
  const minimumFee = envMoney("SHIPPOP_MIN_CUSTOMER_FEE", 35);
  return roundMoney(Math.max(providerPrice + handlingFee, minimumFee));
}

export async function listCarriers(): Promise<ShippingCarrier[]> {
  await ensureShippingCarrierProviderColumn();
  const [rows] = await pool.query(
    "SELECT * FROM Shipping_carriers ORDER BY sc_id"
  );
  return rows as ShippingCarrier[];
}

// รายการขนส่งกลางทั้งหมดที่ active พร้อมระบุว่าร้านนี้เปิดใช้ตัวไหนบ้าง (ยังไม่เคยตั้งค่า = เปิดใช้ทุกตัวเป็น default)
export async function listStoreCarriers(stId: number): Promise<StoreShippingCarrier[]> {
  await ensureShippingCarrierProviderColumn();
  await ensureStoreShippingCarriersTable();

  const [carriers] = await pool.query(
    "SELECT * FROM Shipping_carriers WHERE is_active = 1 ORDER BY sc_id"
  );
  const [enabledRows] = await pool.query(
    "SELECT sc_id FROM Store_shipping_carriers WHERE st_id = ?",
    [stId]
  );
  const enabledIds = (enabledRows as { sc_id: number }[]).map((row) => row.sc_id);
  const hasCustomSelection = enabledIds.length > 0;
  const enabledSet = new Set(enabledIds);

  return (carriers as ShippingCarrier[]).map((carrier) => ({
    ...carrier,
    is_enabled: hasCustomSelection ? enabledSet.has(carrier.sc_id) : true,
  }));
}

// บันทึก subset ขนส่งของร้าน แทนที่ทั้งชุด (full replace)
export async function replaceStoreCarriers(stId: number, scIds: number[]): Promise<void> {
  await ensureStoreShippingCarriersTable();

  const uniqueScIds = Array.from(new Set(scIds));
  if (uniqueScIds.length === 0) {
    throw new ApiError(400, "กรุณาเลือกขนส่งอย่างน้อย 1 รายการ");
  }

  const [validRows] = await pool.query(
    "SELECT sc_id FROM Shipping_carriers WHERE is_active = 1 AND sc_id IN (?)",
    [uniqueScIds]
  );
  const validIds = new Set((validRows as { sc_id: number }[]).map((row) => row.sc_id));
  if (validIds.size !== uniqueScIds.length) {
    throw new ApiError(400, "มีขนส่งที่เลือกไม่ถูกต้องหรือไม่เปิดใช้งาน");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM Store_shipping_carriers WHERE st_id = ?", [stId]);
    await conn.query(
      "INSERT INTO Store_shipping_carriers (st_id, sc_id) VALUES ?",
      [uniqueScIds.map((scId) => [stId, scId])]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function createCarrier(input: CreateCarrierInput): Promise<number> {
  await ensureShippingCarrierProviderColumn();
  const { sc_code, sc_name, calc_type, vol_divisor = null, tracking_url_template = null, is_active = 1 } = input;
  const shippopConfig = resolveShippopCarrierConfig(sc_code, input.shippop_courier_code);

  if (calc_type === "CHARGEABLE_WEIGHT" && !vol_divisor) {
    throw new ApiError(400, "จำเป็นต้องระบุ vol_divisor สำหรับการคิดน้ำหนักเชิงปริมาตร");
  }

  const [dup] = await pool.query(
    "SELECT sc_id FROM Shipping_carriers WHERE sc_code = ?",
    [sc_code.toUpperCase()]
  );
  if ((dup as unknown[]).length > 0) {
    throw new ApiError(409, `รหัสขนส่ง "${sc_code}" มีอยู่แล้วในระบบ`);
  }

  const [result] = await pool.query(
    "INSERT INTO Shipping_carriers (sc_code, sc_name, shippop_courier_code, calc_type, vol_divisor, tracking_url_template, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      sc_code.toUpperCase(),
      sc_name,
      shippopConfig.providerCode,
      calc_type,
      calc_type === "WEIGHT_ONLY" ? null : vol_divisor,
      tracking_url_template?.trim() || null,
      is_active,
    ]
  );
  return (result as { insertId: number }).insertId;
}

export async function updateCarrier(scId: number, input: UpdateCarrierInput): Promise<void> {
  await ensureShippingCarrierProviderColumn();
  const carrier = await findCarrierById(scId);
  if (!carrier) throw new ApiError(404, "ไม่พบข้อมูลขนส่ง");

  if (input.sc_code !== undefined) {
    const [dup] = await pool.query(
      "SELECT sc_id FROM Shipping_carriers WHERE sc_code = ? AND sc_id != ?",
      [input.sc_code.toUpperCase(), scId]
    );
    if ((dup as unknown[]).length > 0) {
      throw new ApiError(409, `รหัสขนส่ง "${input.sc_code}" มีอยู่แล้วในระบบ`);
    }
  }

  const newCalcType = input.calc_type ?? carrier.calc_type;
  const newVolDivisor = input.vol_divisor ?? carrier.vol_divisor;
  const newScCode = input.sc_code ?? carrier.sc_code;
  const newShippopCode = input.shippop_courier_code ?? carrier.shippop_courier_code;
  const shouldUpdateShippopCode = input.sc_code !== undefined || input.shippop_courier_code !== undefined;
  const shippopConfig = shouldUpdateShippopCode
    ? resolveShippopCarrierConfig(newScCode, newShippopCode)
    : null;
  if (newCalcType === "CHARGEABLE_WEIGHT" && !newVolDivisor) {
    throw new ApiError(400, "จำเป็นต้องระบุ vol_divisor สำหรับการคิดน้ำหนักเชิงปริมาตร");
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.sc_code !== undefined) { fields.push("sc_code = ?"); values.push(input.sc_code.toUpperCase()); }
  if (input.sc_name !== undefined) { fields.push("sc_name = ?"); values.push(input.sc_name); }
  if (shippopConfig) {
    fields.push("shippop_courier_code = ?");
    values.push(shippopConfig.providerCode);
  }
  if (input.calc_type !== undefined) { fields.push("calc_type = ?"); values.push(input.calc_type); }
  if (input.vol_divisor !== undefined) { fields.push("vol_divisor = ?"); values.push(input.vol_divisor); }
  // template นี้ใช้สร้าง tracking URL อัตโนมัติจากเลขพัสดุ เช่น https://track.example.com/{tracking_no}
  if (input.tracking_url_template !== undefined) {
    fields.push("tracking_url_template = ?");
    values.push(input.tracking_url_template?.trim() || null);
  }
  if (input.is_active !== undefined) { fields.push("is_active = ?"); values.push(input.is_active); }

  if (fields.length === 0) return;
  values.push(scId);

  await pool.query(
    `UPDATE Shipping_carriers SET ${fields.join(", ")} WHERE sc_id = ?`,
    values
  );
}

export async function toggleCarrierActive(scId: number): Promise<void> {
  const [result] = await pool.query(
    "UPDATE Shipping_carriers SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE sc_id = ?",
    [scId]
  );
  if ((result as { affectedRows: number }).affectedRows === 0) {
    throw new ApiError(404, "ไม่พบข้อมูลขนส่ง");
  }
}

export async function deleteCarrier(scId: number): Promise<void> {
  const [rates] = await pool.query(
    "SELECT COUNT(*) as cnt FROM Shipping_rates WHERE sc_id = ?",
    [scId]
  );
  const rateCount = (rates as { cnt: number }[])[0]?.cnt ?? 0;
  if (rateCount > 0) {
    throw new ApiError(409, "ไม่สามารถลบได้ เนื่องจากยังมีอัตราค่าส่งอยู่ กรุณาลบอัตราค่าส่งทั้งหมดก่อน");
  }

  const [zones] = await pool.query(
    "SELECT COUNT(*) as cnt FROM Postcode_zone_rules WHERE sc_id = ?",
    [scId]
  );
  const zoneCount = (zones as { cnt: number }[])[0]?.cnt ?? 0;
  if (zoneCount > 0) {
    throw new ApiError(409, "ไม่สามารถลบได้ เนื่องจากยังมีกฎโซนอยู่ กรุณาลบกฎโซนทั้งหมดก่อน");
  }

  const [result] = await pool.query(
    "DELETE FROM Shipping_carriers WHERE sc_id = ?",
    [scId]
  );
  if ((result as { affectedRows: number }).affectedRows === 0) {
    throw new ApiError(404, "ไม่พบข้อมูลขนส่ง");
  }
}

async function findCarrierById(scId: number): Promise<ShippingCarrier | null> {
  await ensureShippingCarrierProviderColumn();
  const [rows] = await pool.query(
    "SELECT * FROM Shipping_carriers WHERE sc_id = ?",
    [scId]
  );
  return (rows as ShippingCarrier[])[0] ?? null;
}

// ─── Rates ────────────────────────────────────────────────────────────────────

export async function listRates(scId: number): Promise<ShippingRate[]> {
  const [rows] = await pool.query(
    "SELECT * FROM Shipping_rates WHERE sc_id = ? ORDER BY zone_code, weight_from",
    [scId]
  );
  return rows as ShippingRate[];
}

export async function createRate(input: CreateRateInput): Promise<number> {
  const { sc_id, zone_code, weight_from, weight_to, sr_price } = input;

  validateWeightRange(weight_from, weight_to);
  await assertNoRateOverlap(sc_id, zone_code, weight_from, weight_to);

  const [result] = await pool.query(
    "INSERT INTO Shipping_rates (sc_id, zone_code, weight_from, weight_to, sr_price) VALUES (?, ?, ?, ?, ?)",
    [sc_id, zone_code.toUpperCase(), weight_from, weight_to, sr_price]
  );
  return (result as { insertId: number }).insertId;
}

export async function updateRate(srId: number, input: UpdateRateInput): Promise<void> {
  const [existing] = await pool.query(
    "SELECT * FROM Shipping_rates WHERE sr_id = ?",
    [srId]
  );
  const current = (existing as ShippingRate[])[0];
  if (!current) throw new ApiError(404, "ไม่พบข้อมูลอัตราค่าส่ง");

  if (
    input.weight_from !== undefined ||
    input.weight_to !== undefined ||
    input.zone_code !== undefined
  ) {
    const newFrom = input.weight_from ?? current.weight_from;
    const newTo = input.weight_to ?? current.weight_to;
    const newZone = input.zone_code ?? current.zone_code;
    validateWeightRange(newFrom, newTo);
    await assertNoRateOverlap(current.sc_id, newZone, newFrom, newTo, srId);
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.zone_code !== undefined) { fields.push("zone_code = ?"); values.push(input.zone_code.toUpperCase()); }
  if (input.weight_from !== undefined) { fields.push("weight_from = ?"); values.push(input.weight_from); }
  if (input.weight_to !== undefined) { fields.push("weight_to = ?"); values.push(input.weight_to); }
  if (input.sr_price !== undefined) { fields.push("sr_price = ?"); values.push(input.sr_price); }

  if (fields.length === 0) return;
  values.push(srId);

  await pool.query(
    `UPDATE Shipping_rates SET ${fields.join(", ")} WHERE sr_id = ?`,
    values
  );
}

export async function deleteRate(srId: number): Promise<void> {
  const [result] = await pool.query(
    "DELETE FROM Shipping_rates WHERE sr_id = ?",
    [srId]
  );
  if ((result as { affectedRows: number }).affectedRows === 0) {
    throw new ApiError(404, "ไม่พบข้อมูลอัตราค่าส่ง");
  }
}

function validateWeightRange(from: number, to: number): void {
  if (from < 0) throw new ApiError(400, "น้ำหนักตั้งต้นต้องไม่ติดลบ");
  if (to <= from) throw new ApiError(400, "น้ำหนักสิ้นสุดต้องมากกว่าน้ำหนักตั้งต้น");
}

async function assertNoRateOverlap(scId: number, zoneCode: string, from: number, to: number, excludeId?: number
): Promise<void> {
  const params: unknown[] = [scId, zoneCode.toUpperCase(), to, from];
  const excludeClause = excludeId ? " AND sr_id != ?" : "";
  if (excludeId) params.push(excludeId);

  const [rows] = await pool.query(
    `SELECT sr_id, weight_from, weight_to FROM Shipping_rates
     WHERE sc_id = ? AND zone_code = ? AND weight_from <= ? AND weight_to >= ?${excludeClause}`,
    params
  );
  const conflicts = rows as { sr_id: number; weight_from: number; weight_to: number }[];
  const conflict = conflicts[0];
  if (conflict) {
    throw new ApiError(
      409,
      `มีช่วงน้ำหนักนี้อยู่แล้ว กรุณาเลือกช่วงน้ำหนักใหม่`
    );
  }
}

// ─── Zone Rules ───────────────────────────────────────────────────────────────

export async function listZoneRules(scId: number): Promise<PostcodeZoneRule[]> {
  const [rows] = await pool.query(
    "SELECT * FROM Postcode_zone_rules WHERE sc_id = ? ORDER BY zone_code, postcode_from",
    [scId]
  );
  return rows as PostcodeZoneRule[];
}

export async function createZoneRule(input: CreateZoneRuleInput): Promise<number> {
  const { sc_id, zone_code, postcode_from, postcode_to, priority, is_active = 1 } = input;

  validatePostcodeRange(postcode_from, postcode_to);
  await assertNoZoneOverlap(sc_id, zone_code, postcode_from, postcode_to);

  const [result] = await pool.query(
    "INSERT INTO Postcode_zone_rules (sc_id, zone_code, postcode_from, postcode_to, priority, is_active) VALUES (?, ?, ?, ?, ?, ?)",
    [sc_id, zone_code.toUpperCase(), postcode_from, postcode_to, priority, is_active]
  );
  return (result as { insertId: number }).insertId;
}

export async function updateZoneRule(pzrId: number, input: UpdateZoneRuleInput): Promise<void> {
  const [existing] = await pool.query(
    "SELECT * FROM Postcode_zone_rules WHERE pzr_id = ?",
    [pzrId]
  );
  const current = (existing as PostcodeZoneRule[])[0];
  if (!current) throw new ApiError(404, "ไม่พบข้อมูลกฎโซน");

  if (
    input.postcode_from !== undefined ||
    input.postcode_to !== undefined ||
    input.zone_code !== undefined
  ) {
    const newFrom = input.postcode_from ?? current.postcode_from;
    const newTo = input.postcode_to ?? current.postcode_to;
    const newZone = input.zone_code ?? current.zone_code;
    validatePostcodeRange(newFrom, newTo);
    await assertNoZoneOverlap(current.sc_id, newZone, newFrom, newTo, pzrId);
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.zone_code !== undefined) { fields.push("zone_code = ?"); values.push(input.zone_code.toUpperCase()); }
  if (input.postcode_from !== undefined) { fields.push("postcode_from = ?"); values.push(input.postcode_from); }
  if (input.postcode_to !== undefined) { fields.push("postcode_to = ?"); values.push(input.postcode_to); }
  if (input.priority !== undefined) { fields.push("priority = ?"); values.push(input.priority); }
  if (input.is_active !== undefined) { fields.push("is_active = ?"); values.push(input.is_active); }

  if (fields.length === 0) return;
  values.push(pzrId);

  await pool.query(
    `UPDATE Postcode_zone_rules SET ${fields.join(", ")} WHERE pzr_id = ?`,
    values
  );
}

export async function deleteZoneRule(pzrId: number): Promise<void> {
  const [existing] = await pool.query(
    "SELECT sc_id, zone_code FROM Postcode_zone_rules WHERE pzr_id = ?",
    [pzrId]
  );
  const current = (existing as Pick<PostcodeZoneRule, "sc_id" | "zone_code">[])[0];
  if (!current) throw new ApiError(404, "ไม่พบข้อมูลกฎโซน");

  const [rates] = await pool.query(
    "SELECT COUNT(*) as cnt FROM Shipping_rates WHERE sc_id = ? AND zone_code = ?",
    [current.sc_id, current.zone_code]
  );
  const rateCount = (rates as { cnt: number }[])[0]?.cnt ?? 0;
  if (rateCount > 0) {
    throw new ApiError(409, "โซนนี้มีอัตราค่าส่งใช้งานอยู่ กรุณาลบอัตราค่าส่งของโซนนี้ก่อน");
  }

  const [result] = await pool.query(
    "DELETE FROM Postcode_zone_rules WHERE pzr_id = ?",
    [pzrId]
  );
  if ((result as { affectedRows: number }).affectedRows === 0) {
    throw new ApiError(404, "ไม่พบข้อมูลกฎโซน");
  }
}

function validatePostcodeRange(from: number, to: number): void {
  if (from < 10000 || from > 96999) throw new ApiError(400, "รหัสไปรษณีย์ตั้งต้นไม่ถูกต้อง (10000–96999)");
  if (to < 10000 || to > 96999) throw new ApiError(400, "รหัสไปรษณีย์สิ้นสุดไม่ถูกต้อง (10000–96999)");
  if (to < from) throw new ApiError(400, "รหัสไปรษณีย์สิ้นสุดต้องไม่น้อยกว่าตั้งต้น");
}

async function assertNoZoneOverlap(
  scId: number,
  zoneCode: string,
  from: number,
  to: number,
  excludeId?: number
): Promise<void> {
  const params: unknown[] = [scId, zoneCode.toUpperCase(), to, from];
  const excludeClause = excludeId ? " AND pzr_id != ?" : "";
  if (excludeId) params.push(excludeId);

  const [rows] = await pool.query(
    `SELECT pzr_id FROM Postcode_zone_rules
     WHERE sc_id = ? AND zone_code = ? AND postcode_from <= ? AND postcode_to >= ?${excludeClause}`,
    params
  );
  if ((rows as unknown[]).length > 0) {
    throw new ApiError(
      409,
      "พื้นที่นี้ถูกตั้งค่าไว้แล้ว กรุณาเลือกพื้นที่อื่น"
    );
  }
}

// ─── Calculator ───────────────────────────────────────────────────────────────

export async function calculateShipping(input: CalculateInput): Promise<CalculateResult[]> {
  await ensureShippingCarrierProviderColumn();
  await ensureStoreShippingCarriersTable();
  const postcode = Number(input.postcode);
  const weightG = Number(input.weight_g);

  if (isNaN(postcode) || postcode < 10000 || postcode > 96999) {
    throw new ApiError(400, "รหัสไปรษณีย์ไม่ถูกต้อง");
  }
  if (isNaN(weightG) || weightG <= 0) {
    throw new ApiError(400, "น้ำหนักต้องมากกว่า 0");
  }

  // ถ้าระบุ st_id: ร้านที่ยังไม่เคยตั้งค่าขนส่งเอง (ไม่มีแถวใน Store_shipping_carriers) ใช้ขนส่งกลางทั้งหมดเป็น default
  // ร้านที่ตั้งค่าแล้วจะเห็นเฉพาะขนส่งที่เลือกไว้
  const [carriers] = input.st_id
    ? await pool.query(
        `SELECT sc.* FROM Shipping_carriers sc
         WHERE sc.is_active = 1
           AND (
             NOT EXISTS (SELECT 1 FROM Store_shipping_carriers WHERE st_id = ?)
             OR EXISTS (SELECT 1 FROM Store_shipping_carriers WHERE st_id = ? AND sc_id = sc.sc_id)
           )
         ORDER BY sc.sc_id`,
        [input.st_id, input.st_id]
      )
    : await pool.query(
        "SELECT * FROM Shipping_carriers WHERE is_active = 1 ORDER BY sc_id"
      );

  // ถ้ามี origin_postcode ให้ลองใช้ราคา live จาก SHIPPOP ก่อน เพราะ checkout ควรอิงราคาจริงจาก provider
  // rate table เดิมยังถูกใช้เป็น fallback เผื่อ SHIPPOP ล่ม/ยังไม่ได้ตั้ง API key/ต้องทดสอบใน local
  if (input.origin_postcode) {
    const shippopResults = await calculateShippopShipping(input, carriers as ShippingCarrier[]);
    if (shippopResults.length > 0) {
      // console.log("[shipping] source=shippop", {
      //   origin_postcode: input.origin_postcode,
      //   postcode: input.postcode,
      //   weight_g: input.weight_g,
      //   options: shippopResults.map((option) => ({
      //     sc_code: option.sc_code,
      //     price: option.price,
      //     provider_price: option.provider_price ?? null,
      //     source: option.source,
      //   })),
      // });
      return shippopResults;
    }
  }

  const manualResults = await calculateManualShipping(input, carriers as ShippingCarrier[]);
  // console.log("[shipping] source=manual", {
  //   reason: input.origin_postcode ? "shippop_unavailable_or_no_matching_carrier" : "missing_origin_postcode",
  //   origin_postcode: input.origin_postcode ?? null,
  //   postcode: input.postcode,
  //   weight_g: input.weight_g,
  //   options: manualResults.map((option) => ({
  //     sc_code: option.sc_code,
  //     price: option.price,
  //     provider_price: option.provider_price ?? null,
  //     source: option.source,
  //   })),
  // });
  return manualResults;
}

async function calculateShippopShipping(input: CalculateInput, carriers: ShippingCarrier[]): Promise<CalculateResult[]> {
  const originPostcode = String(input.origin_postcode ?? "");
  const destinationPostcode = String(input.postcode ?? "");
  const enabledCarrierByCode = new Map(
    carriers.map((carrier) => [
      normalizeShippopCourierCode(carrier.shippop_courier_code ?? carrier.sc_code),
      carrier,
    ])
  );

  try {
    const quotes = await quoteShippopRates({
      from: {
        name: "Origin",
        address: input.origin_address?.trim() || "-",
        district: input.origin_subdistrict?.trim() || "-",
        state: input.origin_district?.trim() || "-",
        province: input.origin_province?.trim() || "-",
        postcode: originPostcode,
        tel: "0000000000",
      },
      to: {
        name: "Destination",
        address: input.destination_address?.trim() || "-",
        district: input.destination_subdistrict?.trim() || "-",
        state: input.destination_district?.trim() || "-",
        province: input.destination_province?.trim() || "-",
        postcode: destinationPostcode,
        tel: "0000000000",
      },
      parcel: {
        name: "Parcel",
        weight: Math.ceil(Number(input.weight_g)),
        width: input.width_cm ?? 1,
        length: input.length_cm ?? 1,
        height: input.height_cm ?? 1,
      },
    });

    // console.log("[shipping] shippop quotes", {
    //   origin_postcode: originPostcode,
    //   postcode: destinationPostcode,
    //   weight_g: input.weight_g,
    //   carrier_codes: carriers.map((carrier) => ({
    //     db: carrier.sc_code,
    //     shippop: normalizeShippopCourierCode(carrier.sc_code),
    //   })),
    //   quotes: quotes.map((quote) => ({
    //     courierCode: quote.courierCode,
    //     courierName: quote.courierName,
    //     price: quote.price,
    //   })),
    // });

    return quotes
      .flatMap((quote): CalculateResult[] => {
        const carrier = enabledCarrierByCode.get(quote.courierCode);
        if (!carrier) return [];

        return [{
          sc_id: carrier.sc_id,
          sc_code: carrier.sc_code,
          sc_name: carrier.sc_name || quote.courierName || carrier.sc_code,
          calc_type: carrier.calc_type,
          billed_weight_g: Math.ceil(Number(input.weight_g)),
          zone_code: "SHIPPOP",
          price: calculateCustomerShippingFee(quote.price),
          provider_price: quote.price,
          is_active: carrier.is_active,
          source: "shippop" as const,
        }];
      });
  } catch (err) {
    // console.warn("[shipping] shippop quote failed, fallback enabled", {
    //   message: err instanceof Error ? err.message : String(err),
    //   origin_postcode: input.origin_postcode ?? null,
    //   postcode: input.postcode,
    //   weight_g: input.weight_g,
    // });
    if (process.env.SHIPPOP_RATE_FALLBACK !== "false") return [];
    throw err;
  }
}

async function calculateManualShipping(input: CalculateInput, carriers: ShippingCarrier[]): Promise<CalculateResult[]> {
  const postcode = Number(input.postcode);
  const weightG = Number(input.weight_g);
  const results: CalculateResult[] = [];

  for (const carrier of carriers) {
    let billedWeight = weightG;

    const volumeCm3 =
      input.volume_cm3 ??
      (input.length_cm && input.width_cm && input.height_cm
        ? input.length_cm * input.width_cm * input.height_cm
        : null);

    if (
      carrier.calc_type === "CHARGEABLE_WEIGHT" &&
      carrier.vol_divisor &&
      volumeCm3
    ) {
      const volWeightG = (volumeCm3 / carrier.vol_divisor) * 1000;
      billedWeight = Math.max(weightG, volWeightG);
    }
    billedWeight = Math.ceil(billedWeight);

    const [zoneRows] = await pool.query(
      `SELECT zone_code FROM Postcode_zone_rules
       WHERE sc_id = ? AND COALESCE(is_active, 1) = 1 AND postcode_from <= ? AND postcode_to >= ?
       ORDER BY priority ASC LIMIT 1`,
      [carrier.sc_id, postcode, postcode]
    );
    const zoneCode = (zoneRows as { zone_code: string }[])[0]?.zone_code ?? "ALL";

    const [rateRows] = await pool.query(
      `SELECT sr_price FROM Shipping_rates
       WHERE sc_id = ? AND zone_code = ? AND weight_from <= ? AND weight_to >= ?
       LIMIT 1`,
      [carrier.sc_id, zoneCode, billedWeight, billedWeight]
    );
    const price = (rateRows as { sr_price: number }[])[0]?.sr_price ?? null;

    results.push({
      sc_id: carrier.sc_id,
      sc_code: carrier.sc_code,
      sc_name: carrier.sc_name,
      calc_type: carrier.calc_type,
      billed_weight_g: Math.round(billedWeight),
      zone_code: zoneCode,
      price,
      is_active: carrier.is_active,
      source: "manual",
    });
  }

  return results;
}
