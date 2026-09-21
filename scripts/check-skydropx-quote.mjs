import "dotenv/config";
import { quoteSkydropxRates } from "../dist/modules/shipping/providers/skydropx.js";
import { calculateShipping } from "../dist/modules/shipping/shipping.service.js";
import { pool } from "../dist/db/pool.js";

if (process.env.SKYDROPX_MODE !== "sandbox" || process.env.SKYDROPX_MOCK !== "false") {
  console.error("Expected SKYDROPX_MODE=sandbox and SKYDROPX_MOCK=false.");
  process.exit(1);
}

// Sample Mexican address from the Skydropx quotation documentation.
const address = {
  name: "Prueba",
  address: "Monterrey Centro",
  province: "Nuevo León",
  state: "Monterrey",
  district: "Monterrey Centro",
  postcode: "64000",
  tel: "0000000000",
};

try {
  const rates = await quoteSkydropxRates({
    from: address,
    to: address,
    parcel: { name: "Prueba", weight: 1000, length: 10, width: 10, height: 10 },
  });
  console.log(JSON.stringify({
    quotationCreated: rates.length > 0,
    rateCount: rates.length,
    carriers: [...new Set(rates.map((rate) => rate.courierCode))],
    lowestPrice: rates.length ? Math.min(...rates.map((rate) => rate.price)) : null,
  }));
  if (!rates.length) process.exitCode = 1;

  const [carriers] = await pool.query(
    "SELECT provider_code FROM Shipping_carriers WHERE is_active = 1 AND provider_code IS NOT NULL"
  );
  const activeCodes = [...new Set(carriers.map((carrier) => String(carrier.provider_code).trim().toLowerCase()))];
  const returnedCodes = new Set(rates.map((rate) => rate.courierCode));
  const matchedCodes = activeCodes.filter((code) => returnedCodes.has(code));
  console.log(JSON.stringify({ activeCarrierCodes: activeCodes, matchedCarrierCodes: matchedCodes }));
  if (!matchedCodes.length) process.exitCode = 1;

  const checkoutRates = await calculateShipping({
    origin_postcode: address.postcode,
    origin_province: address.province,
    origin_district: address.state,
    origin_subdistrict: address.district,
    postcode: address.postcode,
    destination_province: address.province,
    destination_district: address.state,
    destination_subdistrict: address.district,
    weight_g: 1000,
    length_cm: 10,
    width_cm: 10,
    height_cm: 10,
  });
  console.log(JSON.stringify({ checkoutRateCount: checkoutRates.length, checkoutCarrierCodes: checkoutRates.map((rate) => rate.provider_code) }));
  if (!checkoutRates.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    status: error.statusCode ?? error.status ?? null,
    message: error.message,
  }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
