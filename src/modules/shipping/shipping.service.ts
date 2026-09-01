import { pool } from "../../db/pool.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import { normalizeSkydropxCarrierCode, quoteSkydropxRates } from "./providers/skydropx.js";
import type {
  CalculateInput,
  CalculateResult,
  CreateCarrierInput,
  ShippingCarrier,
  UpdateCarrierInput,
} from "./shipping.type.js";

let providerColumnReady: Promise<void> | null = null;

export async function ensureShippingCarrierProviderColumn(): Promise<void> {
  providerColumnReady ??= pool.query(
    `SELECT COLUMN_NAME AS column_name
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'Shipping_carriers'
       AND COLUMN_NAME = 'provider_code'`
  ).then(async ([columns]) => {
    if ((columns as unknown[]).length === 0) {
      await pool.query("ALTER TABLE Shipping_carriers ADD COLUMN provider_code VARCHAR(80) NULL AFTER sc_name");
    }
  }).then(() => undefined);
  return providerColumnReady;
}

function providerCode(value: string) {
  const normalized = normalizeSkydropxCarrierCode(value);
  if (!normalized) throw new ApiError(400, "จำเป็นต้องระบุ provider_code ของ Skydropx");
  return normalized;
}

export async function listCarriers(): Promise<ShippingCarrier[]> {
  await ensureShippingCarrierProviderColumn();
  const [rows] = await pool.query(
    `SELECT sc_id, sc_code, sc_name, provider_code, calc_type, vol_divisor, tracking_url_template, is_active
     FROM Shipping_carriers
     ORDER BY sc_id`
  );
  return rows as ShippingCarrier[];
}

export async function createCarrier(input: CreateCarrierInput): Promise<number> {
  await ensureShippingCarrierProviderColumn();
  const code = input.sc_code.trim().toUpperCase();
  const [duplicates] = await pool.query("SELECT sc_id FROM Shipping_carriers WHERE sc_code = ?", [code]);
  if ((duplicates as unknown[]).length) throw new ApiError(409, `รหัสขนส่ง "${code}" มีอยู่แล้วในระบบ`);
  if (input.calc_type === "CHARGEABLE_WEIGHT" && !input.vol_divisor) {
    throw new ApiError(400, "จำเป็นต้องระบุ vol_divisor สำหรับน้ำหนักเชิงปริมาตร");
  }
  const [result] = await pool.query(
    `INSERT INTO Shipping_carriers
      (sc_code, sc_name, provider_code, calc_type, vol_divisor, tracking_url_template, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      code,
      input.sc_name.trim(),
      providerCode(input.provider_code),
      input.calc_type,
      input.calc_type === "WEIGHT_ONLY" ? null : input.vol_divisor ?? null,
      input.tracking_url_template?.trim() || null,
      input.is_active ?? 1,
    ]
  );
  return (result as { insertId: number }).insertId;
}

export async function updateCarrier(scId: number, input: UpdateCarrierInput): Promise<void> {
  await ensureShippingCarrierProviderColumn();
  const fields: string[] = [];
  const values: unknown[] = [];
  if (input.sc_code !== undefined) { fields.push("sc_code = ?"); values.push(input.sc_code.trim().toUpperCase()); }
  if (input.sc_name !== undefined) { fields.push("sc_name = ?"); values.push(input.sc_name.trim()); }
  if (input.provider_code !== undefined) { fields.push("provider_code = ?"); values.push(providerCode(input.provider_code)); }
  if (input.calc_type !== undefined) { fields.push("calc_type = ?"); values.push(input.calc_type); }
  if (input.vol_divisor !== undefined) { fields.push("vol_divisor = ?"); values.push(input.vol_divisor); }
  if (input.tracking_url_template !== undefined) { fields.push("tracking_url_template = ?"); values.push(input.tracking_url_template?.trim() || null); }
  if (input.is_active !== undefined) { fields.push("is_active = ?"); values.push(input.is_active); }
  if (!fields.length) return;
  values.push(scId);
  const [result] = await pool.query(`UPDATE Shipping_carriers SET ${fields.join(", ")} WHERE sc_id = ?`, values);
  if ((result as { affectedRows: number }).affectedRows === 0) throw new ApiError(404, "ไม่พบข้อมูลขนส่ง");
}

export async function toggleCarrierActive(scId: number): Promise<void> {
  const [result] = await pool.query(
    "UPDATE Shipping_carriers SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END WHERE sc_id = ?",
    [scId]
  );
  if ((result as { affectedRows: number }).affectedRows === 0) throw new ApiError(404, "ไม่พบข้อมูลขนส่ง");
}

export async function deleteCarrier(scId: number): Promise<void> {
  const [result] = await pool.query("DELETE FROM Shipping_carriers WHERE sc_id = ?", [scId]);
  if ((result as { affectedRows: number }).affectedRows === 0) throw new ApiError(404, "ไม่พบข้อมูลขนส่ง");
}

function assertMexicanPostcode(value: string, label: string) {
  if (!/^\d{5}$/.test(value)) throw new ApiError(400, `${label}ต้องเป็นรหัสไปรษณีย์เม็กซิโก 5 หลัก`);
}

export async function calculateShipping(input: CalculateInput): Promise<CalculateResult[]> {
  await ensureShippingCarrierProviderColumn();
  assertMexicanPostcode(String(input.postcode), "รหัสไปรษณีย์ปลายทาง");
  if (!input.origin_postcode) throw new ApiError(400, "ไม่พบรหัสไปรษณีย์ต้นทางสำหรับขอราคา Skydropx");
  assertMexicanPostcode(String(input.origin_postcode), "รหัสไปรษณีย์ต้นทาง");
  if (!Number.isFinite(Number(input.weight_g)) || Number(input.weight_g) <= 0) {
    throw new ApiError(400, "น้ำหนักต้องมากกว่า 0");
  }

  const [rows] = await pool.query(
    `SELECT sc_id, sc_code, sc_name, provider_code, calc_type, vol_divisor, tracking_url_template, is_active
     FROM Shipping_carriers
     WHERE is_active = 1 AND provider_code IS NOT NULL AND provider_code != ''
     ORDER BY sc_id`
  );
  const carriers = rows as ShippingCarrier[];
  if (!carriers.length) throw new ApiError(400, "ยังไม่มี carrier ของ Skydropx ที่เปิดใช้งาน");

  const quotes = await quoteSkydropxRates({
    from: {
      name: "Origen",
      address: input.origin_address?.trim() || "Sin número",
      district: input.origin_subdistrict?.trim() || "Centro",
      state: input.origin_district?.trim() || "Municipio",
      province: input.origin_province?.trim() || "Estado",
      postcode: String(input.origin_postcode),
      tel: "0000000000",
    },
    to: {
      name: "Destino",
      address: input.destination_address?.trim() || "Sin número",
      district: input.destination_subdistrict?.trim() || "Centro",
      state: input.destination_district?.trim() || "Municipio",
      province: input.destination_province?.trim() || "Estado",
      postcode: String(input.postcode),
      tel: "0000000000",
    },
    parcel: {
      name: "Pedido Arcana",
      weight: Math.ceil(Number(input.weight_g)),
      length: Math.max(Math.ceil(Number(input.length_cm) || 1), 1),
      width: Math.max(Math.ceil(Number(input.width_cm) || 1), 1),
      height: Math.max(Math.ceil(Number(input.height_cm) || 1), 1),
    },
    requestedCarriers: carriers.map((carrier) => carrier.provider_code),
  });

  const carrierByCode = new Map(carriers.map((carrier) => [providerCode(carrier.provider_code), carrier]));
  const cheapestByCarrier = new Map<string, (typeof quotes)[number]>();
  for (const quote of quotes) {
    const code = providerCode(quote.courierCode);
    const current = cheapestByCarrier.get(code);
    if (!current || quote.price < current.price) cheapestByCarrier.set(code, quote);
  }
  return [...cheapestByCarrier.values()].flatMap((quote): CalculateResult[] => {
    const carrier = carrierByCode.get(providerCode(quote.courierCode));
    if (!carrier) return [];
    return [{
      sc_id: carrier.sc_id,
      sc_code: carrier.sc_code,
      sc_name: carrier.sc_name,
      provider_code: carrier.provider_code,
      calc_type: carrier.calc_type,
      billed_weight_g: Math.ceil(Number(input.weight_g)),
      price: quote.price,
      provider_price: quote.price,
      is_active: carrier.is_active,
      source: "skydropx",
    }];
  });
}
