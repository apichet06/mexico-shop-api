import { ApiError } from "../../../shared/errors/ApiError.js";
import type {
  ShippingAddress,
  ShippingParcel,
  CreateShippingShipmentInput,
  ShippingTrackingResult,
  ShippingTrackingState,
} from "./provider.types.js";

export type SkydropxQuoteInput = {
  from: ShippingAddress;
  to: ShippingAddress;
  parcel: ShippingParcel;
  requestedCarrier?: string | null;
  requestedCarriers?: string[];
  declaredValue?: number;
};

export type SkydropxQuoteResult = {
  quotationId: string;
  rateId: string;
  courierCode: string;
  courierName: string | null;
  serviceName: string | null;
  price: number;
  raw: unknown;
};

export type SkydropxShipmentResult = {
  purchaseId: number | null;
  providerShipmentId: string;
  courierTrackingCode: string | null;
  courierCode: string;
  shipmentStatus: string;
  trackingUrl: string;
  labelUrl: string | null;
  raw: unknown;
};

const DEFAULT_PROD_URL = "https://api-pro.skydropx.com";
const DEFAULT_SANDBOX_URL = "https://sb-pro.skydropx.com";
let tokenCache: { token: string; expiresAt: number } | null = null;

export function normalizeSkydropxCarrierCode(code: string) {
  return code.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function mapSkydropxShipmentStatus(orderStatus: string | null, states: ShippingTrackingState[]) {
  const latestState = [...states].sort((a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime())[0];
  const code = latestState?.status?.toLowerCase() ?? "";
  const order = orderStatus?.toLowerCase() ?? "";
  if (["delivered", "complete", "completed"].includes(order) || code === "delivered") return "delivered";
  if (["created", "label_created"].includes(order)) return "label_created";
  if (["last_mile", "delivery_attempt", "delivered_to_branch"].includes(code)) return "out_for_delivery";
  if (code === "picked_up") return "picked_up";
  if (["exception", "canceled", "in_return", "retained"].includes(code)) return code;
  if (order === "in_transit" || states.length > 0) return "in_transit";
  return null;
}

function getBaseUrl() {
  const configured = process.env.SKYDROPX_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  return process.env.SKYDROPX_MODE === "production" ? DEFAULT_PROD_URL : DEFAULT_SANDBOX_URL;
}

function requiredEnv(name: "SKYDROPX_CLIENT_ID" | "SKYDROPX_CLIENT_SECRET") {
  const value = process.env[name]?.trim();
  if (!value) throw new ApiError(400, `Todavía no se ha configurado ${name}.`); // `ยังไม่ได้ตั้งค่า ${name}`
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(...values: unknown[]) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stringValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function collectFieldErrors(value: unknown, field: string, messages: string[]) {
  if (typeof value === "string" && value.trim()) {
    messages.push(field ? `${field}: ${value.trim()}` : value.trim());
  } else if (Array.isArray(value)) {
    for (const item of value) collectFieldErrors(item, field, messages);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectFieldErrors(item, field ? `${field}.${key}` : key, messages);
    }
  }
}

function collectMessages(value: unknown, messages: string[] = []): string[] {
  if (!value || typeof value !== "object") return messages;
  if (Array.isArray(value)) {
    for (const item of value) collectMessages(item, messages);
    return messages;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "errors") collectFieldErrors(item, "", messages);
    if (["message", "error", "error_description", "error_message_detail", "detail"].includes(key)) {
      if (typeof item === "string" && item.trim()) messages.push(item.trim());
      else if (Array.isArray(item)) messages.push(...item.map(String).filter(Boolean));
    }
    if (item && typeof item === "object") collectMessages(item, messages);
  }
  return messages;
}

function apiError(path: string, status: number, raw: unknown) {
  const messages = [...new Set(collectMessages(raw))];
  return new ApiError(
    status === 400 || status === 401 || status === 403 || status === 422 ? status : 502,
    messages.join(", ") || `La llamada a la API de Skydropx falló (${status})`, // `เรียก Skydropx API ไม่สำเร็จ (${status})`
    { provider: "skydropx", path, httpStatus: status, raw }
  );
}

async function parseResponse(res: Response) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const path = "/api/v1/oauth/token";
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: requiredEnv("SKYDROPX_CLIENT_ID"),
    client_secret: requiredEnv("SKYDROPX_CLIENT_SECRET"),
  });
  const res = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const raw = await parseResponse(res);
  if (!res.ok) throw apiError(path, res.status, raw);

  const payload = record(raw);
  const token = stringValue(payload.access_token, record(payload.data).access_token);
  if (!token) throw new ApiError(502, "Skydropx no devolvió el access token.", { provider: "skydropx", raw }); // "Skydropx ไม่ส่ง access token กลับมา"
  const expiresIn = numberValue(payload.expires_in, record(payload.data).expires_in) ?? 7200;
  tokenCache = { token, expiresAt: Date.now() + Math.max(expiresIn, 60) * 1000 };
  return token;
}

async function requestSkydropx(path: string, init: RequestInit = {}, retryAuth = true): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  const raw = await parseResponse(res);
  if (res.status === 401 && retryAuth) {
    await getAccessToken(true);
    return requestSkydropx(path, init, false);
  }
  if (!res.ok) throw apiError(path, res.status, raw);
  return raw;
}

function toAddress(address: ShippingAddress, includeContact = false) {
  const base: Record<string, unknown> = {
    country_code: "MX",
    postal_code: address.postcode,
    area_level1: address.province?.trim() || "-",
    area_level2: address.state?.trim() || "-",
    area_level3: address.district?.trim() || "-",
  };
  if (!includeContact) return base;
  return {
    ...base,
    name: address.name,
    street1: address.address,
    company: address.name,
    phone: address.tel.replace(/\D/g, "").slice(-10),
    email: address.email?.trim() || process.env.SKYDROPX_DEFAULT_EMAIL?.trim() || "no-reply@example.com",
    reference: Array.from(address.address.trim()).slice(0, 30).join("") || "Sin referencia",
  };
}

function quotationId(raw: unknown) {
  const root = record(raw);
  const data = record(root.data);
  return stringValue(root.id, data.id, record(data.attributes).id);
}

function walkObjects(value: unknown, output: Record<string, unknown>[] = []) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, output);
    return output;
  }
  const item = value as Record<string, unknown>;
  output.push(item);
  for (const nested of Object.values(item)) walkObjects(nested, output);
  return output;
}

function parseRates(raw: unknown, fallbackQuotationId: string): SkydropxQuoteResult[] {
  const results = new Map<string, SkydropxQuoteResult>();
  for (const row of walkObjects(raw)) {
    const attrs = record(row.attributes);
    const source = Object.keys(attrs).length ? { ...row, ...attrs } : row;
    const rateId = stringValue(source.id, source.rate_id);
    const providerName = stringValue(source.provider_name, source.carrier_name, record(source.carrier).name);
    const price = numberValue(source.total, source.amount, source.total_value_with_protection, source.price);
    if (!rateId || !providerName || price == null || source.success === false) continue;
    const code = providerName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    results.set(rateId, {
      quotationId: fallbackQuotationId,
      rateId,
      courierCode: code,
      courierName: stringValue(source.provider_display_name, providerName),
      serviceName: stringValue(source.provider_service_name, source.service_name, source.provider_service_code),
      price,
      raw: row,
    });
  }
  return [...results.values()];
}

function buildQuotation(input: SkydropxQuoteInput) {
  return {
    quotation: {
      address_from: toAddress(input.from),
      address_to: toAddress(input.to),
      parcels: [{
        length: Math.max(Math.ceil(input.parcel.length), 1),
        width: Math.max(Math.ceil(input.parcel.width), 1),
        height: Math.max(Math.ceil(input.parcel.height), 1),
        weight: Math.max(Math.ceil(input.parcel.weight) / 1000, 0.01),
        package_protected: false,
        declared_value: Math.max(input.declaredValue ?? 0, 0),
      }],
      ...((input.requestedCarriers?.length || input.requestedCarrier?.trim())
        ? { requested_carriers: (input.requestedCarriers?.length
          ? input.requestedCarriers
          : [input.requestedCarrier as string]
        ).map(normalizeSkydropxCarrierCode).filter(Boolean) }
        : {}),
    },
  };
}

function mockQuote(input: SkydropxQuoteInput): SkydropxQuoteResult[] {
  const price = Math.round((75 + Math.max(input.parcel.weight / 1000, 1) * 12) * 100) / 100;
  const carriers = input.requestedCarriers?.length
    ? input.requestedCarriers
    : [input.requestedCarrier?.trim() || "estafeta"];
  return carriers.map((value) => {
    const carrier = normalizeSkydropxCarrierCode(value);
    return {
      quotationId: "mock-quotation",
      rateId: `mock-rate-${carrier}`,
      courierCode: carrier,
      courierName: carrier.replace(/_/g, " "),
      serviceName: "Standard",
      price,
      raw: { mock: true },
    };
  });
}

export async function quoteSkydropxRates(input: SkydropxQuoteInput): Promise<SkydropxQuoteResult[]> {
  if (process.env.SKYDROPX_MOCK === "true") return mockQuote(input);
  const created = await requestSkydropx("/api/v2/quotations", {
    method: "POST",
    body: JSON.stringify(buildQuotation(input)),
  });
  const id = quotationId(created);
  if (!id) throw new ApiError(502, "Skydropx no devolvió el quotation id.", { provider: "skydropx", raw: created }); // "Skydropx ไม่ส่ง quotation id กลับมา"

  let latest: unknown = created;
  const attempts = Math.min(Math.max(Number(process.env.SKYDROPX_QUOTE_POLL_ATTEMPTS) || 10, 1), 10);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rates = parseRates(latest, id);
    const completed = record(record(latest).data).is_completed ?? record(latest).is_completed;
    if (rates.length && (completed === true || attempt === attempts - 1)) return rates;
    if (attempt < attempts - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      latest = await requestSkydropx(`/api/v1/quotations/${encodeURIComponent(id)}`);
    }
  }
  return parseRates(latest, id);
}

function findShipment(raw: unknown) {
  const root = record(raw);
  const data = Array.isArray(root.data) ? root.data : root.data ? [root.data] : [root];
  const shipment = record(data[0]);
  const included = Array.isArray(root.included) ? root.included : [];
  const parcel = included.map(record).find((row) => {
    const attrs = record(row.attributes);
    return Boolean(stringValue(row.tracking_number, attrs.tracking_number, row.label_url, attrs.label_url));
  });
  return { shipment, parcel: record(parcel) };
}

function shipmentLabelUrl(shipment: Record<string, unknown>, parcel: Record<string, unknown>) {
  return stringValue(
    record(parcel.attributes).label_url,
    parcel.label_url,
    record(shipment.attributes).label_url,
    shipment.label_url,
  );
}

export async function getSkydropxShipmentLabel(providerShipmentId: string): Promise<string | null> {
  if (process.env.SKYDROPX_MOCK === "true") return null;
  const raw = await requestSkydropx(`/api/v1/shipments/${encodeURIComponent(providerShipmentId)}`);
  const { shipment, parcel } = findShipment(raw);
  return shipmentLabelUrl(shipment, parcel);
}

function mockShipment(input: CreateShippingShipmentInput): SkydropxShipmentResult {
  const digits = input.orderNo.replace(/\D/g, "").slice(-10).padStart(10, "0");
  const tracking = `SKY${digits}`;
  return {
    purchaseId: null,
    providerShipmentId: tracking,
    courierTrackingCode: tracking,
    courierCode: input.courierCode,
    shipmentStatus: "label_created",
    trackingUrl: `https://www.skydropx.com/rastreo/?tracking_number=${encodeURIComponent(tracking)}`,
    labelUrl: null,
    raw: { mock: true, note: "SKYDROPX_MOCK=true; no se compró ninguna guía" },
  };
}

export async function createSkydropxShipment(input: CreateShippingShipmentInput): Promise<SkydropxShipmentResult> {
  if (process.env.SKYDROPX_MOCK === "true") return mockShipment(input);
  const consignmentNote = process.env.SKYDROPX_CONSIGNMENT_NOTE?.trim();
  const packageType = process.env.SKYDROPX_PACKAGE_TYPE?.trim();
  if (!consignmentNote || !/^\d{8}$/.test(consignmentNote)) {
    throw new ApiError(503, "Configura SKYDROPX_CONSIGNMENT_NOTE con el código de Carta Porte de 8 dígitos del producto que se va a enviar."); // "กรุณาตั้งค่า SKYDROPX_CONSIGNMENT_NOTE เป็นรหัส Carta Porte 8 หลักของสินค้าที่จัดส่ง"
  }
  if (!packageType) {
    throw new ApiError(503, "Configura SKYDROPX_PACKAGE_TYPE con el código de tipo de empaque de Skydropx."); // "กรุณาตั้งค่า SKYDROPX_PACKAGE_TYPE เป็นรหัสประเภทบรรจุภัณฑ์ของ Skydropx"
  }
  const rates = await quoteSkydropxRates({
    from: input.from,
    to: input.to,
    parcel: input.parcel,
    requestedCarrier: input.courierCode,
    declaredValue: input.declaredValue,
  });
  const normalizedCarrier = normalizeSkydropxCarrierCode(input.courierCode);
  const rate = rates
    .filter((item) => item.courierCode === normalizedCarrier)
    .sort((a, b) => a.price - b.price)[0] ?? [...rates].sort((a, b) => a.price - b.price)[0];
  if (!rate) throw new ApiError(400, `Skydropx no tiene una tarifa disponible para ${input.courierCode}.`); // `Skydropx ไม่มีราคาที่ใช้ได้สำหรับ ${input.courierCode}`

  let raw = await requestSkydropx("/api/v2/shipments", {
    method: "POST",
    body: JSON.stringify({
      shipment: {
        rate_id: rate.rateId,
        unique_shipment: true,
        printing_format: process.env.SKYDROPX_PRINTING_FORMAT?.trim() || "thermal",
        address_from: toAddress(input.from, true),
        address_to: toAddress(input.to, true),
        packages: [{
          package_number: "1",
          package_protected: false,
          declared_value: Math.max(input.declaredValue, 0),
          consignment_note: consignmentNote,
          package_type: packageType,
        }],
      },
    }),
  });
  let { shipment, parcel } = findShipment(raw);
  let attrs = record(shipment.attributes);
  let parcelAttrs = record(parcel.attributes);
  const providerShipmentId = stringValue(shipment.id, attrs.id);
  let tracking = stringValue(attrs.master_tracking_number, shipment.tracking_number, attrs.tracking_number, parcel.tracking_number, parcelAttrs.tracking_number);
  for (let attempt = 0; providerShipmentId && attempt < 5 && (!tracking || !shipmentLabelUrl(shipment, parcel)); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    try {
      raw = await requestSkydropx(`/api/v1/shipments/${encodeURIComponent(providerShipmentId)}`);
      ({ shipment, parcel } = findShipment(raw));
      attrs = record(shipment.attributes);
      parcelAttrs = record(parcel.attributes);
      tracking = stringValue(attrs.master_tracking_number, shipment.tracking_number, attrs.tracking_number, parcel.tracking_number, parcelAttrs.tracking_number);
    } catch {
      // Skydropx may not expose the newly accepted shipment immediately.
    }
  }
  if (!tracking) throw new ApiError(502, "Skydropx ya recibió la solicitud de creación del shipment, pero el número de tracking aún no está listo. Revisa el shipment en Skydropx antes de intentar crearlo de nuevo.", { provider: "skydropx", providerShipmentId, raw }); // "Skydropx รับคำขอสร้าง shipment แล้ว แต่เลข tracking ยังไม่พร้อม กรุณาตรวจ shipment ใน Skydropx ก่อนลองสร้างซ้ำ"

  return {
    purchaseId: null,
    providerShipmentId: providerShipmentId ?? tracking,
    courierTrackingCode: tracking,
    courierCode: rate.courierCode,
    shipmentStatus: stringValue(attrs.workflow_status, shipment.status, attrs.status) ?? "label_created",
    trackingUrl: stringValue(parcelAttrs.tracking_url_provider, attrs.tracking_url_provider)
      ?? `https://www.skydropx.com/rastreo/?tracking_number=${encodeURIComponent(tracking)}`,
    labelUrl: shipmentLabelUrl(shipment, parcel),
    raw,
  };
}

export async function getSkydropxTracking(trackingNumber: string, carrierName = ""): Promise<ShippingTrackingResult> {
  if (process.env.SKYDROPX_MOCK === "true") {
    const state: ShippingTrackingState = {
      status: "created",
      datetime: new Date().toISOString(),
      location: null,
      description: "Guía creada",
      raw: { mock: true },
    };
    return { status: true, orderStatus: "created", trackingCode: trackingNumber, courierTrackingCode: trackingNumber, states: [state], raw: { mock: true } };
  }
  if (!carrierName.trim()) {
    return { status: true, orderStatus: null, trackingCode: trackingNumber, courierTrackingCode: trackingNumber, states: [], raw: null };
  }
  const path = `/api/v1/shipments/tracking?tracking_number=${encodeURIComponent(trackingNumber)}&carrier_name=${encodeURIComponent(carrierName)}`;
  let raw: unknown;
  try {
    raw = await requestSkydropx(path);
  } catch (error) {
    // Skydropx documents 404 here as "this tracking number has no events yet".
    if (error instanceof ApiError && record(error.details).httpStatus === 404) {
      return { status: true, orderStatus: null, trackingCode: trackingNumber, courierTrackingCode: trackingNumber, states: [], raw: null };
    }
    throw error;
  }
  const data = record(raw).data;
  const rows = (Array.isArray(data) ? data : []).map(record);
  const states: ShippingTrackingState[] = rows.map((row) => {
    const attrs = record(row.attributes);
    const status = stringValue(row.status, attrs.status);
    return {
      status,
      datetime: stringValue(attrs.date, row.date, row.occurred_at, row.updated_at, attrs.occurred_at, attrs.updated_at, attrs.created_at) ?? new Date().toISOString(),
      location: stringValue(row.location, attrs.location),
      description: stringValue(attrs.event_description, row.event_description, row.description, row.message, attrs.description, attrs.message, status) ?? "Actualización de envío",
      raw: row,
    };
  }).filter((state) => state.status);
  const latest = states[0]?.status ?? null;
  return { status: true, orderStatus: latest, trackingCode: trackingNumber, courierTrackingCode: trackingNumber, states, raw };
}
