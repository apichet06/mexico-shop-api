import crypto from "crypto";
import { ApiError } from "../../../shared/errors/ApiError.js";

export type ShippopAddress = {
  name: string;
  address: string;
  district?: string | null;
  state?: string | null;
  province?: string | null;
  postcode: string;
  tel: string;
  email?: string | null;
};

export type ShippopParcel = {
  name: string;
  weight: number;
  width: number;
  length: number;
  height: number;
};

export type ShippopCreateShipmentInput = {
  email: string;
  orderNo: string;
  courierCode: string;
  from: ShippopAddress;
  to: ShippopAddress;
  parcel: ShippopParcel;
  products: Array<{
    product_code: string;
    name: string;
    price: number;
    amount: number;
    weight: number;
  }>;
  declaredValue: number;
  codAmount?: number;
  remark?: string | null;
};

export type ShippopQuoteInput = {
  from: ShippopAddress;
  to: ShippopAddress;
  parcel: ShippopParcel;
};

export type ShippopQuoteResult = {
  courierCode: string;
  courierName: string | null;
  price: number;
  raw: unknown;
};

export type ShippopShipmentResult = {
  purchaseId: number | null;
  shippopTrackingCode: string;
  courierTrackingCode: string | null;
  courierCode: string;
  shipmentStatus: string;
  trackingUrl: string;
  labelUrl: string | null;
  raw: unknown;
};

export type ShippopTrackingState = {
  status: string | null;
  datetime: string;
  location: string | null;
  description: string;
  info?: unknown;
  raw: unknown;
};

export type ShippopTrackingResult = {
  status: boolean;
  orderStatus: string | null;
  trackingCode: string;
  courierTrackingCode: string | null;
  states: ShippopTrackingState[];
  raw: unknown;
};

const DEFAULT_DEV_URL = "https://mkpservice.shippop.dev";
const DEFAULT_PROD_URL = "https://mkpservice.shippop.com";
export const SHIPPOP_COURIER_PRESETS = [
  {
    scCode: "FLASH",
    courierCode: "FLE",
    name: "Flash Express",
    calcType: "CHARGEABLE_WEIGHT",
    volDivisor: 5000,
    trackingUrlTemplate: "https://www.shippop.com/tracking/?tracking_code={tracking_no}",
  },
  {
    scCode: "FLASH_FRUIT",
    courierCode: "FLEF",
    name: "FlashExpress Fruit",
    calcType: "CHARGEABLE_WEIGHT",
    volDivisor: 5000,
    trackingUrlTemplate: "https://www.shippop.com/tracking/?tracking_code={tracking_no}",
  },
  {
    scCode: "KERRY",
    courierCode: "KRYX",
    name: "Kerry Exclusive",
    calcType: "CHARGEABLE_WEIGHT",
    volDivisor: 5000,
    trackingUrlTemplate: "https://www.shippop.com/tracking/?tracking_code={tracking_no}",
  },
  {
    scCode: "THP",
    courierCode: "EMST",
    name: "ไปรษณีย์ไทย EMS",
    calcType: "WEIGHT_ONLY",
    volDivisor: null,
    trackingUrlTemplate: "https://www.shippop.com/tracking/?tracking_code={tracking_no}",
  },
  {
    scCode: "DHL",
    courierCode: "DHL",
    name: "DHL Eco",
    calcType: "CHARGEABLE_WEIGHT",
    volDivisor: 5000,
    trackingUrlTemplate: "https://www.shippop.com/tracking/?tracking_code={tracking_no}",
  },
  {
    scCode: "BEST",
    courierCode: "BEST",
    name: "Best Express",
    calcType: "CHARGEABLE_WEIGHT",
    volDivisor: 5000,
    trackingUrlTemplate: "https://www.shippop.com/tracking/?tracking_code={tracking_no}",
  },
  {
    scCode: "SPX",
    courierCode: "SPX",
    name: "Shopee Xpress",
    calcType: "CHARGEABLE_WEIGHT",
    volDivisor: 5000,
    trackingUrlTemplate: "https://www.shippop.com/tracking/?tracking_code={tracking_no}",
  },
] as const;

const COURIER_CODE_ALIASES: Record<string, string> = {
  FLASH: "FLE",
  FLASH_FRUIT: "FLEF",
  KERRY: "KRYX",
  THP: "EMST",
};

export function normalizeShippopCourierCode(code: string) {
  const normalized = code.trim().toUpperCase();
  return COURIER_CODE_ALIASES[normalized] ?? normalized;
}

export function getShippopCarrierPreset(scCode: string) {
  const normalized = scCode.trim().toUpperCase();
  return SHIPPOP_COURIER_PRESETS.find((carrier) => carrier.scCode === normalized) ?? null;
}

function getBaseUrl() {
  const configured = process.env.SHIPPOP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return process.env.SHIPPOP_MODE === "production" ? DEFAULT_PROD_URL : DEFAULT_DEV_URL;
}

function getApiKey() {
  const apiKey = process.env.SHIPPOP_API_KEY?.trim();
  if (!apiKey) throw new ApiError(400, "ยังไม่ได้ตั้งค่า SHIPPOP_API_KEY");
  return apiKey;
}

function getMarketPayload() {
  const marketId = process.env.SHIPPOP_MARKET_ID?.trim();
  return marketId ? { market_id: marketId } : {};
}

function getEmail(inputEmail: string) {
  const email = process.env.SHIPPOP_EMAIL?.trim() || inputEmail?.trim();
  if (!email) throw new ApiError(400, "ยังไม่ได้ตั้งค่า SHIPPOP_EMAIL หรืออีเมลร้านค้า");
  return email;
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, "").slice(0, 12);
}

function toShippopAddress(address: ShippopAddress) {
  return {
    province: address.province ?? "",
    state: address.state ?? "",
    district: address.district ?? "",
    postcode: address.postcode,
    address: address.address,
    name: address.name,
    tel: normalizePhone(address.tel),
    email: address.email ?? "",
  };
}

function trackingUrl(trackingCode: string) {
  return `https://www.shippop.com/tracking/?tracking_code=${encodeURIComponent(trackingCode)}`;
}

function labelUrl(trackingCode: string) {
  const apiBaseUrl = process.env.API_BASE_URL?.trim()?.replace(/\/$/, "");
  if (!apiBaseUrl) return null;

  const size = process.env.SHIPPOP_LABEL_SIZE?.trim() || "A6";
  const signature = signLabelRequest(trackingCode, size);
  return `${apiBaseUrl}/shipping/labels/${encodeURIComponent(trackingCode)}?size=${encodeURIComponent(size)}&print=1&sig=${encodeURIComponent(signature)}`;
}

function collectShippopMessages(value: unknown, messages: string[] = []): string[] {
  if (!value || typeof value !== "object") return messages;

  const record = value as Record<string, unknown>;
  for (const key of ["message", "error", "notice"]) {
    const message = record[key];
    if (typeof message === "string" && message.trim()) messages.push(message.trim());
    if (Array.isArray(message)) {
      messages.push(...message.map((item) => String(item).trim()).filter(Boolean));
    }
  }

  for (const nested of Object.values(record)) {
    if (nested && typeof nested === "object") collectShippopMessages(nested, messages);
  }

  return messages;
}

function shippopErrorMessage(raw: unknown) {
  const messages = [...new Set(collectShippopMessages(raw))];
  if (messages.length > 0) return messages.join(", ");

  if (raw && typeof raw === "object") {
    const code = (raw as Record<string, unknown>).code;
    const codeMessage = code ? ` (code: ${String(code)})` : "";
    if (process.env.NODE_ENV !== "production") {
      return `SHIPPOP ปฏิเสธรายการ${codeMessage}: ${JSON.stringify(raw)}`;
    }
    return `SHIPPOP ปฏิเสธรายการ${codeMessage}`;
  }

  if (typeof raw === "string" && raw.trim()) {
    return `SHIPPOP ปฏิเสธรายการ: ${raw.trim().slice(0, 500)}`;
  }

  return "SHIPPOP ปฏิเสธรายการ";
}

function shippopErrorDetails(path: string, raw: unknown, httpStatus?: number) {
  return {
    provider: "shippop",
    path,
    httpStatus,
    raw,
  };
}

function signLabelRequest(trackingCode: string, size: string) {
  const secret = process.env.JWT_SECRET || process.env.SHIPPOP_API_KEY || "";
  return crypto
    .createHmac("sha256", secret)
    .update(`${trackingCode}:${size}`)
    .digest("hex");
}

function assertValidLabelSignature(trackingCode: string, size: string, signature: string) {
  const expected = signLabelRequest(trackingCode, size);
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(signature, "hex");

  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw new ApiError(403, "label URL ไม่ถูกต้องหรือหมดอายุ");
  }
}

async function postShippop<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: getApiKey(),
      ...getMarketPayload(),
      ...payload,
    }),
  });

  const responseText = await res.text();
  let raw: unknown = responseText;
  try {
    raw = responseText ? JSON.parse(responseText) : null;
  } catch {
    raw = responseText;
  }

  if (!res.ok) {
    throw new ApiError(
      502,
      shippopErrorMessage(raw) || "เรียก SHIPPOP API ไม่สำเร็จ",
      shippopErrorDetails(path, raw, res.status)
    );
  }
  if (raw && typeof raw === "object" && (raw as { status?: unknown }).status === false) {
    throw new ApiError(400, shippopErrorMessage(raw), shippopErrorDetails(path, raw, res.status));
  }

  return raw as T;
}

export async function getShippopLabelHtml(trackingCodeInput: string, sizeInput = "A6", signature = "") {
  const trackingCode = trackingCodeInput.trim();
  const size = sizeInput.trim() || "A6";
  if (!trackingCode) throw new ApiError(400, "ไม่พบ tracking_code สำหรับเปิด label");
  assertValidLabelSignature(trackingCode, size, signature);

  const raw = await postShippop<Record<string, unknown>>("/label_tracking_code/", {
    tracking_code: trackingCode,
    size,
  });

  const html = raw.html;
  if (typeof html !== "string" || !html.trim()) {
    throw new ApiError(400, shippopErrorMessage(raw) || "SHIPPOP ไม่ส่ง HTML label กลับมา");
  }

  return html;
}

export function withAutoPrint(html: string) {
  return withPrintStyles(html, true);
}

export function withPrintStyles(html: string, autoPrint = false) {
  const style = `
<style id="arcana-label-print-style">
@page {
  size: A6;
  margin: 0;
}

html,
body {
  width: 148mm;
  min-height: 0 !important;
}

* {
  -webkit-print-color-adjust: exact !important;
  print-color-adjust: exact !important;
}

@media print {
  html,
  body {
    width: 148mm !important;
    min-height: 0 !important;
    height: auto !important;
    margin: 0 !important;
    padding: 0 !important;
    background: #fff !important;
    overflow: hidden !important;
  }

  body > *:last-child {
    page-break-after: avoid !important;
    break-after: avoid-page !important;
  }
}
</style>`;

  const script = autoPrint ? `
<script>
window.addEventListener("load", function () {
  window.setTimeout(function () {
    window.focus();
    window.print();
  }, 350);
});
</script>` : "";

  const injection = `${style}${script}`;

  return html.includes("</body>")
    ? html.replace("</body>", `${injection}</body>`)
    : `${html}${injection}`;
}

function firstDataObject(raw: unknown): Record<string, unknown> {
  const data = (raw as { data?: unknown })?.data;
  if (!data || typeof data !== "object") return {};
  if (Array.isArray(data)) return (data[0] as Record<string, unknown>) ?? {};

  const values = Object.values(data as Record<string, unknown>);
  return (values[0] as Record<string, unknown>) ?? {};
}

function firstConfirmObject(raw: unknown): Record<string, unknown> {
  const result = (raw as { result?: unknown })?.result;
  if (!result || typeof result !== "object") return {};
  if (Array.isArray(result)) return (result[0] as Record<string, unknown>) ?? {};

  const values = Object.values(result as Record<string, unknown>);
  return (values[0] as Record<string, unknown>) ?? {};
}

function buildMockResult(input: ShippopCreateShipmentInput): ShippopShipmentResult {
  const digits = input.orderNo.replace(/\D/g, "").slice(-9).padStart(9, "0");
  const shippopTrackingCode = `SP${digits}`;
  const courierTrackingCode = `${input.courierCode}${digits}`;

  return {
    purchaseId: Number(`9${digits.slice(-6)}`),
    shippopTrackingCode,
    courierTrackingCode,
    courierCode: input.courierCode,
    shipmentStatus: "booking",
    trackingUrl: trackingUrl(shippopTrackingCode),
    labelUrl: labelUrl(shippopTrackingCode),
    raw: {
      mock: true,
      note: "SHIPPOP_MOCK=true ใช้ทดสอบ flow บน localhost โดยยังไม่ยิง SHIPPOP จริง",
    },
  };
}

function buildMockTrackingResult(trackingCode: string): ShippopTrackingResult {
  const now = new Date();
  const created = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  return {
    status: true,
    orderStatus: "booking",
    trackingCode,
    courierTrackingCode: null,
    states: [
      {
        status: "booking",
        datetime: created.toISOString(),
        location: null,
        description: "Confirmed booking ,สร้างรายการขนส่งแล้ว",
        raw: { mock: true },
      },
    ],
    raw: { mock: true },
  };
}

function toNumber(value: unknown): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function readQuoteRows(raw: unknown): Record<string, unknown>[] {
  const data = (raw as { data?: unknown })?.data;
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data)) return data.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"));

  return Object.values(data as Record<string, unknown>)
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      if ("courier_code" in record || "courierCode" in record || "code" in record) return [record];
      return Object.values(record).filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"));
    });
}

function readTrackingStateRows(raw: unknown): Record<string, unknown>[] {
  const states = (raw as { states?: unknown })?.states;
  if (Array.isArray(states)) {
    return states.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"));
  }

  const state = (raw as { state?: unknown })?.state;
  if (state && typeof state === "object") {
    return Object.values(state as Record<string, unknown>).filter((row): row is Record<string, unknown> =>
      Boolean(row && typeof row === "object")
    );
  }

  return [];
}

function mapTrackingResult(raw: Record<string, unknown>, fallbackTrackingCode: string): ShippopTrackingResult {
  const states = readTrackingStateRows(raw)
    .flatMap((row): ShippopTrackingState[] => {
      const datetime = String(row.datetime ?? row.occurred_date ?? row.updated_at ?? "").trim();
      const description = String(row.description ?? row.message ?? "").trim();
      if (!datetime || !description) return [];

      return [{
        status: row.status == null ? null : String(row.status).trim() || null,
        datetime,
        location: row.location == null ? null : String(row.location).trim() || null,
        description,
        info: row.info,
        raw: row,
      }];
    });

  return {
    status: Boolean(raw.status),
    orderStatus: raw.order_status == null ? null : String(raw.order_status).trim() || null,
    trackingCode: String(raw.tracking_code ?? fallbackTrackingCode),
    courierTrackingCode: raw.courier_tracking_code == null ? null : String(raw.courier_tracking_code),
    states,
    raw,
  };
}

function buildMockQuotes(input: ShippopQuoteInput): ShippopQuoteResult[] {
  const weightKg = Math.max(Math.ceil(input.parcel.weight / 1000), 1);
  const origin = Number(input.from.postcode.slice(0, 2));
  const destination = Number(input.to.postcode.slice(0, 2));
  const zoneFactor = Number.isFinite(origin) && Number.isFinite(destination) && origin !== destination ? 12 : 0;

  return [
    { courierCode: "FLE", courierName: "Flash Express", price: 35 + weightKg * 8 + zoneFactor, raw: { mock: true } },
    { courierCode: "KRYX", courierName: "KEX Exclusive", price: 45 + weightKg * 10 + zoneFactor, raw: { mock: true } },
    { courierCode: "EMST", courierName: "ไปรษณีย์ไทย EMS", price: 40 + weightKg * 9 + zoneFactor, raw: { mock: true } },
  ];
}

export async function quoteShippopRates(input: ShippopQuoteInput): Promise<ShippopQuoteResult[]> {
  if (process.env.SHIPPOP_MOCK === "true") return buildMockQuotes(input);

  // SHIPPOP official flow starts with GET PRICE before booking. The endpoint returns only available couriers,
  // so checkout can rely on this price list instead of maintaining our own rate table as the source of truth.
  const raw = await postShippop<Record<string, unknown>>("/pricelist/", {
    data: [
      {
        from: toShippopAddress(input.from),
        to: toShippopAddress(input.to),
        parcel: input.parcel,
      },
    ],
  });

  return readQuoteRows(raw)
    .flatMap((row): ShippopQuoteResult[] => {
      const courierCode = String(row.courier_code ?? row.courierCode ?? row.code ?? "").trim().toUpperCase();
      const price = toNumber(row.price ?? row.total_price ?? row.price_total);
      if (!courierCode || price == null) return [];

      return [{
        courierCode,
        courierName: row.courier_name ? String(row.courier_name) : row.name ? String(row.name) : null,
        price,
        raw: row,
      }];
    });
}

export async function getShippopTracking(trackingCodeInput: string): Promise<ShippopTrackingResult> {
  const trackingCode = trackingCodeInput.trim();
  if (!trackingCode) throw new ApiError(400, "ไม่พบ tracking_code สำหรับตรวจสอบสถานะพัสดุ");

  if (process.env.SHIPPOP_MOCK === "true") return buildMockTrackingResult(trackingCode);

  const raw = await postShippop<Record<string, unknown>>("/tracking/", {
    tracking_code: trackingCode,
  });

  return mapTrackingResult(raw, trackingCode);
}

export async function createShippopShipment(input: ShippopCreateShipmentInput): Promise<ShippopShipmentResult> {
  const courierCode = normalizeShippopCourierCode(input.courierCode);
  if (!courierCode) throw new ApiError(400, "ไม่พบรหัสขนส่งของ SHIPPOP");

  if (process.env.SHIPPOP_MOCK === "true") {
    return buildMockResult({ ...input, courierCode });
  }

  const email = getEmail(input.email);

  // SHIPPOP flow: booking ก่อนเพื่อสร้าง purchase_id และ SP tracking code จากนั้น confirm เพื่อส่งรายการเข้าขนส่งจริง
  const booking = await postShippop<Record<string, unknown>>("/booking/", {
    email,
    force_confirm: 0,
    data: [
      {
        from: toShippopAddress(input.from),
        to: toShippopAddress(input.to),
        parcel: input.parcel,
        product: input.products,
        courier_code: courierCode,
        remark: input.remark ?? `Order ${input.orderNo}`,
        cod_amount: input.codAmount ?? 0,
        declared_value: Math.max(input.declaredValue, 0),
        meta: {
          ref_no_1: input.orderNo,
        },
      },
    ],
  });

  const bookingItem = firstDataObject(booking);
  const purchaseId = Number(
    (booking as { purchase_id?: unknown }).purchase_id
      ?? bookingItem.purchase_id
      ?? bookingItem.purchaseId
      ?? bookingItem.id
  );
  const bookingStatus = bookingItem.status;
  if (bookingStatus === false) {
    throw new ApiError(
      400,
      String(bookingItem.message ?? "SHIPPOP booking ไม่สำเร็จ"),
      shippopErrorDetails("/booking/", booking)
    );
  }
  if (!Number.isFinite(purchaseId)) {
    throw new ApiError(400, "SHIPPOP ไม่ส่ง purchase_id กลับมา", shippopErrorDetails("/booking/", booking));
  }

  const confirm = await postShippop<Record<string, unknown>>("/confirm/", {
    purchase_id: purchaseId,
  });
  const confirmItem = firstConfirmObject(confirm);
  if (confirmItem.status === false) {
    throw new ApiError(
      400,
      String(confirmItem.message ?? "SHIPPOP confirm ไม่สำเร็จ"),
      shippopErrorDetails("/confirm/", confirm)
    );
  }

  const shippopTrackingCode = String(confirmItem.tracking_code ?? bookingItem.tracking_code ?? "");
  if (!shippopTrackingCode) {
    throw new ApiError(400, "SHIPPOP ไม่ส่ง tracking_code กลับมา", shippopErrorDetails("/confirm/", confirm));
  }

  const courierTrackingCode = confirmItem.courier_tracking_code ?? bookingItem.courier_tracking_code ?? null;

  return {
    purchaseId,
    shippopTrackingCode,
    courierTrackingCode: courierTrackingCode ? String(courierTrackingCode) : null,
    courierCode: String(confirmItem.courier_code ?? bookingItem.courier_code ?? courierCode),
    shipmentStatus: "booking",
    trackingUrl: trackingUrl(shippopTrackingCode),
    labelUrl: labelUrl(shippopTrackingCode),
    raw: { booking, confirm },
  };
}
