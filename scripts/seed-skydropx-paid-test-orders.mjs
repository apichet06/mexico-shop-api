import "dotenv/config";
import { pool } from "../dist/db/pool.js";
import { calculateShipping } from "../dist/modules/shipping/shipping.service.js";
import { adminGetOrders } from "../dist/modules/orders/orders.service.js";
import { reserveInventoryForOrderItems, consumeReservationsForOrders } from "../dist/modules/inventory/inventory-reservation.service.js";

const prefix = "TEST-SKY-20260921-";
const variantIds = [53, 54, 55, 56, 57, 58, 59];
const buyerEmail = "skydropx-sandbox-buyer-20260921@example.invalid";
const buyer = {
  name: "Skydropx Sandbox Buyer",
  phone: "8111111111",
  address: "Calle de Prueba 100, Monterrey Centro",
  postcode: "64000",
  state: "Nuevo León",
  municipality: "Monterrey",
  colonia: "Monterrey Centro",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function main() {
  assert(process.env.NODE_ENV === "development", "This seed requires NODE_ENV=development.");
  assert(process.env.SKYDROPX_MODE === "sandbox" && process.env.SKYDROPX_MOCK === "false", "This seed requires real Skydropx Sandbox quotes.");

  const [existing] = await pool.query("SELECT or_id, order_no FROM Orders WHERE order_no LIKE ? ORDER BY or_id", [`${prefix}%`]);
  if (existing.length) {
    assert(existing.length === 7, `Found ${existing.length} existing test orders; refusing to add duplicates.`);
    const backofficeOrders = (await adminGetOrders(1)).filter((order) => String(order.order_no).startsWith(prefix));
    assert(backofficeOrders.length === 7 && backofficeOrders.every((order) => Number(order.item_count) === 1), "Backoffice order list did not return all seven test orders.");
    console.log(JSON.stringify({ alreadySeeded: true, backofficeCount: backofficeOrders.length, orders: backofficeOrders.map((order) => ({ or_id: order.or_id, order_no: order.order_no, status_code: order.status_code, hasTracking: Boolean(order.tracking_no) })) }));
    return;
  }

  const [stores] = await pool.query("SELECT st_id, st_company_name, st_phone, st_email FROM Store WHERE st_id = 1 AND st_status = 'ACTIVE'");
  const store = stores[0];
  assert(store, "Active store 1 is unavailable.");
  const [locations] = await pool.query("SELECT loc_id, st_id, loc_address, zip_code, state, municipality, city, colonia FROM Locations WHERE loc_id = 5 AND st_id = 1");
  const warehouse = locations[0];
  assert(warehouse?.loc_address && warehouse.zip_code, "Warehouse 5 has no complete sender address.");
  const [carriers] = await pool.query("SELECT sc_id, provider_code FROM Shipping_carriers WHERE is_active = 1 AND provider_code = 'dhl' LIMIT 1");
  const carrier = carriers[0];
  assert(carrier, "Active DHL carrier is unavailable.");
  const [statuses] = await pool.query("SELECT s_id FROM Status WHERE s_code = 'CONFIRMED' LIMIT 1");
  assert(statuses[0], "CONFIRMED status is missing.");

  const [variants] = await pool.query(
    `SELECT pv.pv_id, pv.p_id, pv.pv_sku, pv.pv_price, pv.pv_cost,
            pv.weight_g, pv.length_cm, pv.width_cm, pv.height_cm, pl.p_name,
            i.inv_id, i.loc_id, i.on_hand, i.reserved_qty
     FROM ProductVariants pv
     JOIN Products p ON p.p_id = pv.p_id AND p.st_id = 1 AND p.p_isActive = 1 AND p.p_isAccept = 1
     JOIN ProductLangs pl ON pl.p_id = p.p_id AND pl.lg_code = 'es'
     JOIN Inventorys i ON i.pv_id = pv.pv_id AND i.loc_id = ?
     WHERE pv.pv_id IN (?)
     ORDER BY FIELD(pv.pv_id, ?)`,
    [warehouse.loc_id, variantIds, variantIds]
  );
  assert(variants.length === 7, `Expected 7 sellable variants, found ${variants.length}.`);
  for (const variant of variants) {
    assert(Number(variant.on_hand) - Number(variant.reserved_qty) >= 1, `Variant ${variant.pv_id} has insufficient stock.`);
    for (const field of ["weight_g", "length_cm", "width_cm", "height_cm"]) {
      assert(Number(variant[field]) > 0, `Variant ${variant.pv_id} has invalid ${field}.`);
    }
  }

  const planned = [];
  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    const rates = await calculateShipping({
      origin_postcode: warehouse.zip_code,
      origin_address: warehouse.loc_address,
      origin_province: warehouse.state,
      origin_district: warehouse.municipality || warehouse.city,
      origin_subdistrict: warehouse.colonia,
      postcode: buyer.postcode,
      destination_address: buyer.address,
      destination_province: buyer.state,
      destination_district: buyer.municipality,
      destination_subdistrict: buyer.colonia,
      weight_g: Number(variant.weight_g),
      length_cm: Number(variant.length_cm),
      width_cm: Number(variant.width_cm),
      height_cm: Number(variant.height_cm),
    });
    const dhl = rates.find((rate) => rate.sc_id === carrier.sc_id);
    assert(dhl && Number.isFinite(Number(dhl.price)), `No DHL Sandbox rate for variant ${variant.pv_id}.`);
    planned.push({ variant, shippingFee: roundMoney(Number(dhl.price)), orderNo: `${prefix}${String(index + 1).padStart(2, "0")}` });
  }
  console.log(JSON.stringify({ dryRun: !process.argv.includes("--apply"), orders: planned.map(({ variant, shippingFee, orderNo }) => ({ orderNo, pv_id: variant.pv_id, subtotal: Number(variant.pv_price), shippingFee })) }));
  if (!process.argv.includes("--apply")) return;

  const conn = await pool.getConnection();
  const created = [];
  try {
    await conn.beginTransaction();
    const [buyerResult] = await conn.query("INSERT INTO Users SET ?", [{ u_username: buyer.name, u_email: buyerEmail, u_provider: "TEST", u_email_verified: 0, u_create_at: new Date(), u_update_at: new Date() }]);
    const userId = buyerResult.insertId;
    const [cartResult] = await conn.query("INSERT INTO Carts SET ?", [{ u_id: userId, status: "checked_out", created_at: new Date(), updated_at: new Date() }]);
    const cartId = cartResult.insertId;
    await conn.query("INSERT INTO Locations_buyer SET ?", [{ u_id: userId, locb_recipient_name: buyer.name, locb_phone: buyer.phone, locb_address: buyer.address, country_code: "MX", state: buyer.state, city: buyer.municipality, municipality: buyer.municipality, colonia: buyer.colonia, zip_code: buyer.postcode, is_default: 1 }]);

    for (const { variant, shippingFee, orderNo } of planned) {
      const subtotal = roundMoney(Number(variant.pv_price));
      const total = roundMoney(subtotal + shippingFee);
      const [orderResult] = await conn.query("INSERT INTO Orders SET ?", [{ order_no: orderNo, cart_id: cartId, u_id: userId, st_id: store.st_id, s_id: statuses[0].s_id, status: "paid", subtotal, discount_total: 0, shipping_fee: shippingFee, provider_shipping_cost: shippingFee, shipping_sc_id: carrier.sc_id, grand_total: total, shipping_name: buyer.name, shipping_phone: buyer.phone, shipping_address: buyer.address, remark: "TEST ONLY — simulated payment; no Conekta transaction", payment_expires_at: null, created_at: new Date(), update_at: new Date() }]);
      const orderId = orderResult.insertId;
      const [itemResult] = await conn.query("INSERT INTO Order_items SET ?", [{ or_id: orderId, p_id: variant.p_id, pv_id: variant.pv_id, sku: variant.pv_sku, product_name: variant.p_name, variant_name: variant.pv_sku, unit_price: subtotal, discount_amount: 0, qty: 1, line_total: subtotal, cost_snapshot: Number(variant.pv_cost), created_at: new Date() }]);
      await reserveInventoryForOrderItems(conn, [{ or_id: orderId, oi_id: itemResult.insertId, pv_id: variant.pv_id, qty: 1, order_no: orderNo }]);
      await consumeReservationsForOrders(conn, [orderId]);

      const [shipmentResult] = await conn.query("INSERT INTO Order_shipments SET ?", [{ or_id: orderId, loc_id: warehouse.loc_id, shipment_no: `${orderNo}-S01`, status: "planned", sender_name: store.st_company_name ?? "Store #1", sender_phone: store.st_phone, sender_email: store.st_email, sender_address: warehouse.loc_address, sender_zip_code: warehouse.zip_code, sender_province_name: warehouse.state, sender_district_name: warehouse.municipality || warehouse.city, sender_subdistrict_name: warehouse.colonia, recipient_name: buyer.name, recipient_phone: buyer.phone, recipient_address: buyer.address, recipient_zip_code: buyer.postcode, recipient_province_name: buyer.state, recipient_district_name: buyer.municipality, recipient_subdistrict_name: buyer.colonia, created_at: new Date(), updated_at: new Date() }]);
      await conn.query("INSERT INTO Order_shipment_items SET ?", [{ os_id: shipmentResult.insertId, or_id: orderId, oi_id: itemResult.insertId, pv_id: variant.pv_id, qty: 1, created_at: new Date() }]);

      const [paymentResult] = await conn.query("INSERT INTO Payments SET ?", [{ payment_no: `TESTPAY-${orderNo}`, amount_total: total, payment_method: "conekta", payment_status: "paid", payment_ref: null, paid_at: new Date(), created_at: new Date(), u_id: userId }]);
      await conn.query("INSERT INTO Payment_orders SET ?", [{ pay_id: paymentResult.insertId, or_id: orderId, created_at: new Date() }]);
      created.push({ or_id: orderId, order_no: orderNo });
    }

    const [verified] = await conn.query(`SELECT COUNT(DISTINCT o.or_id) AS orders, COUNT(DISTINCT oi.oi_id) AS items,
      COUNT(DISTINCT p.pay_id) AS payments, COUNT(DISTINCT os.os_id) AS shipments,
      COUNT(DISTINCT oir.oir_id) AS consumedReservations
      FROM Orders o JOIN Order_items oi ON oi.or_id = o.or_id
      JOIN Payment_orders po ON po.or_id = o.or_id JOIN Payments p ON p.pay_id = po.pay_id AND p.payment_status = 'paid'
      JOIN Order_shipments os ON os.or_id = o.or_id
      JOIN Order_inventory_reservations oir ON oir.or_id = o.or_id AND oir.status = 'consumed'
      WHERE o.order_no LIKE ? AND o.s_id = ?`, [`${prefix}%`, statuses[0].s_id]);
    assert(Object.values(verified[0]).every((count) => Number(count) === 7), `Seed verification failed: ${JSON.stringify(verified[0])}`);
    await conn.commit();
    console.log(JSON.stringify({ created, verified: verified[0] }));
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? null, message: error.message }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
