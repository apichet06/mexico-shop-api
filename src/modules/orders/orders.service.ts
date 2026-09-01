import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import crypto from "crypto";
import { pool } from "../../db/pool.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import type { AdminOrderDTO, AdminOrderSummaryDTO, AdminSalesByBuyerReportDTO, AdminSalesByBuyerRowDTO, AdminSalesByCategoryReportDTO, AdminSalesByCategoryRowDTO, AdminSalesByProductReportDTO, AdminSalesByProductRowDTO, AdminSalesReportDTO, AdminSalesReportRowDTO, CheckoutOrderInput, CreateOrderInput, OrderDetailDTO, OrderDTO, OrderItemDTO, OrderShipmentDTO, OrderShipmentItemDTO, RefundHistoryEntryDTO, RefundItemDTO, ShipmentEventDTO, StoreShippingOptions } from "./type.js";
import * as couponService from "../coupons/coupon.service.js";
import * as shippingService from "../shipping/shipping.service.js";
import type { CalculateResult } from "../shipping/shipping.type.js";
import { chargeAndRecordPayment, createMercadoPagoRefund } from "../payments/payment.service.js";
import type { PaymentResultDTO } from "../payments/payment.type.js";
import {
    createSkydropxShipment,
    getSkydropxTracking,
    mapSkydropxShipmentStatus,
} from "../shipping/providers/skydropx.js";
import type { ShippingTrackingState } from "../shipping/providers/provider.types.js";
import { getIO } from "../../socket/socket.js";
import { fileUploadImage } from "../../shared/middlewares/fileUploadImage.js";
import * as notificationService from "../notifications/notification.service.js";
import * as chatService from "../chat/chat.service.js";
import type { NotificationPriority } from "../notifications/type.js";
import {
    ensureInventoryReservationTable,
    releaseReservationsForOrders,
    restockConsumedReservationsForItems,
    restockConsumedReservationsForOrders,
    reserveInventoryForOrderItems,
    type InventoryReservationItem,
} from "../inventory/inventory-reservation.service.js";
import {
    BUYER_CANCELLABLE_STATUS_CODES,
    getOrderStatusId,
    type OrderStatusCode,
    setOrdersStatus,
    toLegacyOrderStatus,
} from "./order-status.service.js";
import {
    ensureOrderShipmentLabelColumn,
    ensureOrderShipmentTables,
    ensureRefundImagesTable,
    ensureRefundMethodColumn,
    ensureRefundReturnTrackingColumn,
} from "./orders.schema.js";

const REFUND_REQUESTABLE_STATUS_CODES: OrderStatusCode[] = ["CONFIRMED", "PROCESSING", "PACKED", "DELIVERED"];
const ADMIN_CANCELLABLE_STATUS_CODES: OrderStatusCode[] = ["PENDING", "CONFIRMED"];
const ORDER_RECEIVED_STATUS_CODES: OrderStatusCode[] = ["RECEIVED", "AUTO_RECEIVED", "REVIEWED"];
const ADMIN_STATUS_TRANSITIONS: Record<string, OrderStatusCode> = {
    CONFIRMED: "PROCESSING",
    PROCESSING: "READY_TO_SHIP",
};

let autoReceiveJobStarted = false;

// ปัดเศษจำนวนเงินให้เหลือ 2 ตำแหน่ง ใช้ตอนคำนวณยอด order/shipping/discount
function roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
}

type CheckoutCartItemRow = RowDataPacket & {
    ci_id: number;
    pv_id: number;
    qty: number;
    unit_price: number;
    discount_amount: number;
    line_total: number;
    pv_sku: string | null;
    pv_cost: number;
    weight_g: number | null;
    length_cm: number | null;
    width_cm: number | null;
    height_cm: number | null;
    p_id: number;
    st_id: number;
    st_company_name: string | null;
    p_name: string | null;
    variant_label: string | null;
};

type CheckoutAddressRow = RowDataPacket & {
    locb_recipient_name: string;
    locb_phone: string;
    locb_address: string;
    zip_code: string;
    province_name: string | null;
    district_name: string | null;
    subdistrict_name: string | null;
};

// สร้างเลข order รายวัน และ lock running ล่าสุดใน transaction เพื่อกันเลขซ้ำ
// สร้างเลขคำสั่งซื้อไม่ซ้ำโดยอิงวันที่ปัจจุบันและ sequence รายวัน
async function generateOrderNo(conn: PoolConnection): Promise<string> {
    const now = new Date();
    const yyyymmdd =
        now.getFullYear().toString() +
        String(now.getMonth() + 1).padStart(2, "0") +
        String(now.getDate()).padStart(2, "0");

    const prefix = `ORD${yyyymmdd}-`;
    const [rows] = await conn.query<(RowDataPacket & { order_no: string })[]>(
        "SELECT order_no FROM Orders WHERE order_no LIKE ? ORDER BY order_no DESC LIMIT 1 FOR UPDATE",
        [`${prefix}%`]
    );

    const lastNo = rows[0]?.order_no;
    const lastRunning = lastNo ? Number(lastNo.split("-")[1]) : 0;
    const nextRunning = Number.isFinite(lastRunning) ? lastRunning + 1 : 1;

    return `${prefix}${String(nextRunning).padStart(5, "0")}`;
}

// ใช้ select ชุดเดียวกันทั้ง detail และผลลัพธ์หลัง checkout เพื่อไม่ให้ response field เพี้ยนกัน
const orderSelectSql = `
    SELECT
        o.or_id,
        o.order_no,
        o.u_id,
        o.cart_id,
        o.co_id,
        o.st_id,
        st.st_company_name,
        st.is_platform_store AS st_is_platform_store,
        o.s_id,
        o.status,
        os.s_code AS status_code,
        osl.s_name AS status_label,
        latest_refund.refund_id AS refund_id,
        latest_refund.amount AS refund_amount,
        latest_refund.remark AS refund_remark,
        latest_refund.return_tracking AS return_tracking,
        latest_refund.updated_at AS refund_updated_at,
        latest_refund.status AS refund_status,
        latest_refund.refund_method AS refund_method,
        o.subtotal,
        o.discount_total,
        o.shipping_fee,
        o.provider_shipping_cost,
        o.shipping_sc_id,
        sc.sc_code AS shipping_carrier_code,
        sc.sc_name AS shipping_carrier_name,
        o.tracking_no,
        o.tracking_url,
        o.label_url,
        sc.tracking_url_template,
        o.shipment_status,
        o.grand_total,
        o.coupon_code,
        o.shipping_name,
        o.shipping_phone,
        o.shipping_address,
        lb.zip_code AS shipping_zip_code,
        lb.country_code AS shipping_country_code,
        lb.state AS shipping_state,
        lb.city AS shipping_city,
        lb.municipality AS shipping_municipality,
        lb.colonia AS shipping_colonia,
        lb.state AS shipping_province_name,
        COALESCE(lb.municipality, lb.city) AS shipping_district_name,
        lb.colonia AS shipping_subdistrict_name,
        o.remark,
        o.payment_expires_at,
        o.created_at,
        o.update_at
    FROM Orders o
    LEFT JOIN Store st ON st.st_id = o.st_id
    LEFT JOIN Shipping_carriers sc ON sc.sc_id = o.shipping_sc_id
    LEFT JOIN Status os ON os.s_id = o.s_id
    LEFT JOIN StatusLangs osl ON osl.s_id = os.s_id AND osl.lg_code = ?
    LEFT JOIN Locations_buyer lb
        ON lb.u_id = o.u_id
       AND lb.locb_recipient_name = o.shipping_name
       AND lb.locb_phone = o.shipping_phone
       AND lb.locb_address = o.shipping_address    LEFT JOIN (
        SELECT r1.or_id, r1.refund_id, r1.amount, r1.status, r1.remark, r1.return_tracking, r1.updated_at, r1.refund_method
        FROM Refunds r1
        INNER JOIN (
            SELECT or_id, MAX(refund_id) AS refund_id
            FROM Refunds
            GROUP BY or_id
        ) latest ON latest.refund_id = r1.refund_id
    ) latest_refund ON latest_refund.or_id = o.or_id
`;

const orderItemsSelectSql = `
    SELECT
        oi.oi_id, oi.or_id, oi.p_id, oi.pv_id, oi.sku,
        COALESCE(pv.image_url, ip.ip_image_url) AS image_url,
        COALESCE(pl.p_name, oi.product_name) AS product_name,
        oi.variant_name, oi.unit_price,
        oi.discount_amount, oi.qty, oi.line_total, oi.cost_snapshot,
        p.st_id, p.ctl_id, s.st_company_name,
        EXISTS (
            SELECT 1
            FROM Estimate_delivery ed
            WHERE ed.oi_id = oi.oi_id
        ) AS is_reviewed,
        oi.created_at
    FROM Order_items oi
    LEFT JOIN Products p ON p.p_id = oi.p_id
    LEFT JOIN ProductVariants pv ON pv.pv_id = oi.pv_id
    LEFT JOIN ImageProduct ip ON ip.p_id = oi.p_id AND ip.is_primary = 1
    LEFT JOIN ProductLangs pl ON pl.p_id = oi.p_id AND pl.lg_code = ?
    LEFT JOIN Store s ON s.st_id = p.st_id
`;

const ADMIN_ALL_STORE_ID = 1;
const PAYMENT_EXPIRE_MINUTES = Number(process.env.ORDER_PAYMENT_EXPIRE_MINUTES ?? 1440);
let expirationJobStarted = false;

// เช็คจาก Store.is_platform_store จริง แทนการอิง ADMIN_ALL_STORE_ID (=1) ตรงๆ เพราะ st_id ที่เป็น platform อาจไม่ใช่ 1 เสมอไปในอนาคต
async function isPlatformStore(st_id: number): Promise<boolean> {
    const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT is_platform_store FROM Store WHERE st_id = ? LIMIT 1`,
        [st_id]
    );
    const value = rows[0]?.is_platform_store;
    return value === true || value === 1 || value === "1";
}

type AdminOrderDetailDTO = AdminOrderDTO & {
    items: OrderItemDTO[];
    shipments?: OrderShipmentDTO[];
    refund_images?: string[];
    refund_items?: RefundItemDTO[];
    refund_history?: RefundHistoryEntryDTO[];
};

type OrderNotificationEvent =
    | "order:created"
    | "order:paid"
    | "order:status_updated"
    | "order:tracking_updated"
    | "order:refund_requested"
    | "order:refund_approved"
    | "order:refund_rejected"
    | "order:received"
    | "order:auto_received"
    | "order:cancelled"
    | "order:payment_expired";

type OrderNotificationTarget = "STORE" | "USER";

type OrderNotificationOptions = {
    event: OrderNotificationEvent;
    order: Partial<OrderDTO> & {
        or_id: number;
        order_no: string;
        st_id: number;
        u_id?: number;
    };
    title: string;
    message: string;
    priority?: NotificationPriority;
    targets?: OrderNotificationTarget[];
    actor?: "buyer" | "admin" | "system";
    actionUrl?: string;
};

const statusLabelByCode: Record<string, string> = {
    PENDING: "Pendiente de pago",
    CONFIRMED: "Pago confirmado",
    PROCESSING: "En preparación",
    PACKED: "Empaquetado",
    READY_TO_SHIP: "Listo para enviar",
    DELIVERED: "Entregado",
    RECEIVED: "Recepción confirmada",
    AUTO_RECEIVED: "Recepción confirmada automáticamente",
    REVIEWED: "Reseñado",
    CANCELLED: "Cancelado",
    REFUNDED: "Reembolsado",
};

// แจ้งเตือนถูกเก็บเป็นภาษาสเปน จึงเลือก label มาตรฐานก่อน label ที่มากับ query ภาษาอื่น
function getOrderStatusLabel(order: Partial<OrderDTO>) {
    const statusCode = order.status_code ?? "";
    return statusLabelByCode[statusCode] || order.status_label || statusCode || order.status || "-";
}

// สร้าง URL ไปหน้า order detail ฝั่งร้าน/backoffice
function getStoreOrderActionUrl(order: Pick<OrderDTO, "or_id">) {
    return `/dashboard/orders?order_id=${order.or_id}`;
}

// สร้าง URL ไปหน้า order detail ฝั่ง buyer
function getBuyerOrderActionUrl(order: Pick<OrderDTO, "or_id">) {
    return `/arcana/account/orders?order_id=${order.or_id}`;
}

// ประกอบ payload notification/socket สำหรับเหตุการณ์ของ order
function buildOrderEventPayload(options: OrderNotificationOptions) {
    const { event, order, title, message, actor = "system" } = options;

    return {
        event,
        actor,
        title,
        message,
        created_at: new Date(),
        order: {
            or_id: order.or_id,
            order_no: order.order_no,
            st_id: order.st_id,
            u_id: order.u_id,
            status: order.status,
            status_code: order.status_code,
            status_label: order.status_label,
            grand_total: order.grand_total,
            tracking_no: order.tracking_no,
            tracking_url: order.tracking_url,
            refund_status: order.refund_status,
        },
    };
}

// บันทึก notification ลง DB ให้เป้าหมายที่เกี่ยวข้อง เช่น buyer หรือร้านค้า
async function createOrderNotification(target: OrderNotificationTarget, options: OrderNotificationOptions) {
    const { order, event, title, message, priority = "NORMAL" } = options;
    const targetId = target === "STORE" ? Number(order.st_id) : Number(order.u_id);
    if (!targetId) return;

    await notificationService.CreateNotification({
        target_type: target,
        target_id: targetId,
        type: event,
        title,
        message,
        action_url: options.actionUrl ?? (target === "STORE" ? getStoreOrderActionUrl(order) : getBuyerOrderActionUrl(order)),
        ref_type: "ORDER",
        ref_id: order.or_id,
        priority,
    });
}

// ส่ง notification และ emit socket เมื่อ order มีเหตุการณ์สำคัญ
async function notifyOrderEvent(options: OrderNotificationOptions) {
    const targets = options.targets ?? ["STORE", "USER"];
    const payload = buildOrderEventPayload(options);

    try {
        // บันทึก notification ลงฐานข้อมูลก่อน เพื่อให้ผู้ใช้ที่ offline กลับมาเห็นย้อนหลังได้
        // CreateNotification จะ emit notification:new ไปยัง room เป้าหมายให้อยู่แล้ว
        for (const target of targets) {
            try {
                await createOrderNotification(target, options);
            } catch (error) {
                // ถ้า notification ราย target ใดล้มเหลว ให้ target อื่นและ realtime event ยังเดินต่อได้
                console.warn(`[orders] create notification ${options.event} for ${target} failed:`, error);
            }
        }

        // Emit realtime event เพิ่มอีกชั้นสำหรับหน้า orders/dashboard ที่อยาก update state ทันที
        // ใช้ทั้ง event เฉพาะและ order:changed เพื่อให้ frontend เลือก subscribe ได้ง่าย
        const io = getIO();
        io.to(`STORE_${options.order.st_id}`).emit(options.event, payload);
        io.to(`STORE_${options.order.st_id}`).emit("order:changed", payload);
        if (options.order.u_id) {
            io.to(`USER_${options.order.u_id}`).emit(options.event, payload);
            io.to(`USER_${options.order.u_id}`).emit("order:changed", payload);
        }
    } catch (error) {
        // ห้ามให้ notification/socket ทำให้ order action ที่ commit แล้วล้มเหลว
        console.warn(`[orders] notify ${options.event} failed:`, error);
    }
}

// ส่ง notification หลายรายการแบบเรียงลำดับ ใช้กับ batch job หรือหลาย order
async function notifyManyOrderEvents(orders: OrderNotificationOptions[]) {
    for (const orderNotification of orders) {
        await notifyOrderEvent(orderNotification);
    }
}

// แจ้งเตือน platform store เมื่อ Mercado Pago คืนเงินไม่สำเร็จและต้องโอนคืนเอง
async function notifyPlatformManualRefundNeeded(order: Pick<OrderDTO, "or_id" | "order_no" | "st_company_name">) {
    try {
        await notificationService.NotifyPlatformStores({
            target_type: "STORE",
            type: "order:manual_refund_needed",
            title: "Se requiere un reembolso manual",
            message: `No se pudo reembolsar el pedido ${order.order_no}${order.st_company_name ? ` de la tienda ${order.st_company_name}` : ""} mediante Mercado Pago. Debe transferir el reembolso al cliente manualmente.`,
            action_url: getStoreOrderActionUrl(order),
            ref_type: "ORDER",
            ref_id: order.or_id,
            priority: "HIGH",
        });
    } catch (error) {
        // ห้ามให้ notification ทำให้ order action ที่ commit แล้วล้มเหลว
        console.warn("[orders] notify platform manual refund needed failed:", error);
    }
}

// คำนวณเวลาหมดอายุการชำระเงินของ order pending
function buildPaymentExpiresAt(): Date {
    const minutes = Number.isFinite(PAYMENT_EXPIRE_MINUTES) && PAYMENT_EXPIRE_MINUTES > 0
        ? PAYMENT_EXPIRE_MINUTES
        : 15;
    return new Date(Date.now() + minutes * 60 * 1000);
}

// ดึงรายการสินค้าใน order หลายรายการ แล้วจัดกลุ่มตาม or_id
async function getOrderItems(orIds: number[], lg_code = "es"): Promise<Map<number, OrderItemDTO[]>> {
    const itemMap = new Map<number, OrderItemDTO[]>();
    if (!orIds.length) return itemMap;

    const [itemRows] = await pool.query<(RowDataPacket & OrderItemDTO)[]>(
        `${orderItemsSelectSql} WHERE oi.or_id IN (?) ORDER BY oi.oi_id ASC`,
        [lg_code, orIds]
    );

    // annotate refunded_qty แบบ bulk ในคำสั่งเดียว (ไม่ query แยกต่อออเดอร์) เพื่อให้หน้า list ของ buyer เห็นด้วยว่าแต่ละ item คืนไปแล้วเท่าไหร่
    const [refundedRows] = await pool.query<(RowDataPacket & { oi_id: number; refunded_qty: number })[]>(
        `SELECT ri.oi_id, SUM(ri.qty) AS refunded_qty
         FROM Refund_items ri
         INNER JOIN Refunds r ON r.refund_id = ri.refund_id
         WHERE r.or_id IN (?) AND r.status IN ('pending', 'succeeded')
         GROUP BY ri.oi_id`,
        [orIds]
    );
    const refundedMap = new Map(refundedRows.map((row) => [Number(row.oi_id), Number(row.refunded_qty)]));

    for (const item of itemRows) {
        const orderId = Number(item.or_id);
        const annotatedItem = { ...item, refunded_qty: refundedMap.get(item.oi_id) ?? 0 };
        itemMap.set(orderId, [...(itemMap.get(orderId) ?? []), annotatedItem]);
    }

    return itemMap;
}

// สร้างกลุ่ม shipment เริ่มต้นให้ order ตามร้าน/สินค้า เพื่อเตรียมข้อมูลจัดส่ง
async function createShipmentGroupsForOrders(conn: PoolConnection, orderIds: number[]): Promise<void> {
    if (!orderIds.length) return;
    await ensureOrderShipmentTables();

    const [existingRows] = await conn.query<(RowDataPacket & { cnt: number })[]>(
        "SELECT COUNT(*) AS cnt FROM Order_shipments WHERE or_id IN (?)",
        [orderIds]
    );
    if (Number(existingRows[0]?.cnt ?? 0) > 0) return;

    const [shipmentRows] = await conn.query<(RowDataPacket & {
        or_id: number;
        order_no: string;
        st_id: number;
        loc_id: number;
        st_company_name: string | null;
        st_phone: string | null;
        st_email: string | null;
        loc_address: string | null;
        loc_zip_code: string | null;
        sender_province_name: string | null;
        sender_district_name: string | null;
        sender_subdistrict_name: string | null;
        recipient_name: string;
        recipient_phone: string | null;
        recipient_address: string;
        recipient_zip_code: string | null;
        recipient_province_name: string | null;
        recipient_district_name: string | null;
        recipient_subdistrict_name: string | null;
        total_qty: number;
    })[]>(
        `SELECT
            o.or_id,
            o.order_no,
            o.st_id,
            inv.loc_id,
            st.st_company_name,
            st.st_phone,
            st.st_email,
            loc.loc_address,
            loc.zip_code AS loc_zip_code,
            loc.state AS sender_province_name,
            COALESCE(loc.municipality, loc.city) AS sender_district_name,
            loc.colonia AS sender_subdistrict_name,
            o.shipping_name AS recipient_name,
            o.shipping_phone AS recipient_phone,
            o.shipping_address AS recipient_address,
            lb.zip_code AS recipient_zip_code,
            lb.state AS recipient_province_name,
            COALESCE(lb.municipality, lb.city) AS recipient_district_name,
            lb.colonia AS recipient_subdistrict_name,
            SUM(oir.qty_reserved) AS total_qty
         FROM Order_inventory_reservations oir
         INNER JOIN Inventorys inv ON inv.inv_id = oir.inv_id
         INNER JOIN Orders o ON o.or_id = oir.or_id
         LEFT JOIN Store st ON st.st_id = o.st_id
         LEFT JOIN Locations loc ON loc.loc_id = inv.loc_id         LEFT JOIN Locations_buyer lb
            ON lb.u_id = o.u_id
           AND lb.locb_recipient_name = o.shipping_name
           AND lb.locb_phone = o.shipping_phone
           AND lb.locb_address = o.shipping_address         WHERE oir.or_id IN (?)
         GROUP BY
            o.or_id, o.order_no, o.st_id, inv.loc_id, st.st_company_name, st.st_phone, st.st_email,
            loc.loc_address, loc.zip_code, loc.state, loc.municipality, loc.city, loc.colonia, o.shipping_name, o.shipping_phone, o.shipping_address, lb.zip_code, lb.state, lb.municipality, lb.city, lb.colonia
         ORDER BY o.or_id ASC, inv.loc_id ASC`,
        [orderIds]
    );

    if (!shipmentRows.length) return;

    const shipmentIdByOrderLocation = new Map<string, number>();
    const runningByOrder = new Map<number, number>();

    for (const row of shipmentRows) {
        if (!row.loc_address || !row.loc_zip_code) {
            throw new ApiError(400, "El almacén con el stock reservado no tiene una dirección de remitente completa.");
        }

        const orderId = Number(row.or_id);
        const running = (runningByOrder.get(orderId) ?? 0) + 1;
        runningByOrder.set(orderId, running);

        // Snapshot ผู้ส่ง/ผู้รับ ณ ตอนสร้าง order เพื่อให้ label เก่าไม่เปลี่ยนตามการแก้ที่อยู่คลังหรือที่อยู่ลูกค้าในอนาคต
        const [result] = await conn.query<ResultSetHeader>(
            "INSERT INTO Order_shipments SET ?",
            [{
                or_id: orderId,
                loc_id: row.loc_id,
                shipment_no: `${row.order_no}-S${String(running).padStart(2, "0")}`,
                status: "planned",
                sender_name: row.st_company_name ?? `Store #${row.st_id}`,
                sender_phone: row.st_phone,
                sender_email: row.st_email,
                sender_address: row.loc_address,
                sender_zip_code: row.loc_zip_code,
                sender_province_name: row.sender_province_name,
                sender_district_name: row.sender_district_name,
                sender_subdistrict_name: row.sender_subdistrict_name,
                recipient_name: row.recipient_name,
                recipient_phone: row.recipient_phone,
                recipient_address: row.recipient_address,
                recipient_zip_code: row.recipient_zip_code,
                recipient_province_name: row.recipient_province_name,
                recipient_district_name: row.recipient_district_name,
                recipient_subdistrict_name: row.recipient_subdistrict_name,
                created_at: new Date(),
                updated_at: new Date(),
            }]
        );

        shipmentIdByOrderLocation.set(`${orderId}:${Number(row.loc_id)}`, result.insertId);
    }

    const [itemRows] = await conn.query<(RowDataPacket & {
        or_id: number;
        loc_id: number;
        oi_id: number;
        pv_id: number;
        qty: number;
    })[]>(
        `SELECT
            oir.or_id,
            inv.loc_id,
            oir.oi_id,
            oir.pv_id,
            SUM(oir.qty_reserved) AS qty
         FROM Order_inventory_reservations oir
         INNER JOIN Inventorys inv ON inv.inv_id = oir.inv_id
         WHERE oir.or_id IN (?)
         GROUP BY oir.or_id, inv.loc_id, oir.oi_id, oir.pv_id
         ORDER BY oir.or_id ASC, inv.loc_id ASC, oir.oi_id ASC`,
        [orderIds]
    );

    for (const item of itemRows) {
        const shipmentId = shipmentIdByOrderLocation.get(`${Number(item.or_id)}:${Number(item.loc_id)}`);
        if (!shipmentId) continue;

        await conn.query(
            "INSERT INTO Order_shipment_items SET ?",
            [{
                os_id: shipmentId,
                or_id: item.or_id,
                oi_id: item.oi_id,
                pv_id: item.pv_id,
                qty: item.qty,
                created_at: new Date(),
            }]
        );
    }
}

// แยก tracking code จาก tracking_no หรือ tracking_url ของ provider
function getProviderTrackingCodesFromShipment(shipment: Pick<OrderShipmentDTO, "tracking_no" | "tracking_url">): string[] {
    const codes: string[] = [];
    const trackingUrl = shipment.tracking_url?.trim();
    if (trackingUrl) {
        try {
            const parsed = new URL(trackingUrl);
            const code = parsed.searchParams.get("tracking_code")?.trim();
            if (code) codes.push(code);
        } catch {
            const match = trackingUrl.match(/[?&]tracking_code=([^&]+)/);
            if (match?.[1]) codes.push(decodeURIComponent(match[1]));
        }
    }

    const trackingNo = shipment.tracking_no?.trim();
    if (trackingNo) codes.push(trackingNo);

    return [...new Set(codes.map((code) => code.trim()).filter(Boolean))];
}

// แปลง description จากขนส่งให้เป็น title สั้นสำหรับแสดงใน timeline
function shipmentEventTitle(description: string) {
    const parts = description.split(",").map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1] : description;
}

// แยกรายละเอียดเสริมจาก description ของขนส่ง ถ้ามีหลายส่วน
function shipmentEventDescription(description: string) {
    const parts = description.split(",").map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts[0] : null;
}

// สร้าง hash กันบันทึก shipment event ซ้ำจากข้อมูล tracking เดิม
function eventHash(osId: number, state: ShippingTrackingState) {
    return crypto
        .createHash("sha256")
        .update([osId, state.status ?? "", state.datetime, state.location ?? "", state.description].join("|"))
        .digest("hex");
}

// sync tracking event จาก shipping provider และอัปเดต shipment/order เป็น delivered เมื่อขนส่งส่งสำเร็จ
async function syncShipmentEventsFromProvider(orderIds: number[]): Promise<Map<number, string>> {
    const syncedStatuses = new Map<number, string>();
    if (!orderIds.length || process.env.SKYDROPX_TRACKING_SYNC_ON_READ === "false") return syncedStatuses;
    await ensureOrderShipmentTables();
    await shippingService.ensureShippingCarrierProviderColumn();

    const [shipments] = await pool.query<(RowDataPacket & Pick<OrderShipmentDTO, "os_id" | "or_id" | "tracking_no" | "tracking_url"> & { carrier_code: string | null })[]>(
        `SELECT osh.os_id, osh.or_id, osh.tracking_no, osh.tracking_url,
                sc.provider_code AS carrier_code
         FROM Order_shipments osh
         INNER JOIN Orders o ON o.or_id = osh.or_id
         LEFT JOIN Shipping_carriers sc ON sc.sc_id = o.shipping_sc_id
         WHERE osh.or_id IN (?)
           AND (osh.tracking_no IS NOT NULL OR osh.tracking_url IS NOT NULL)
         ORDER BY osh.os_id ASC`,
        [orderIds]
    );

    for (const shipment of shipments) {
        const trackingCodes = getProviderTrackingCodesFromShipment(shipment);
        if (!trackingCodes.length) continue;

        for (const trackingCode of trackingCodes) {
            try {
                const tracking = await getSkydropxTracking(trackingCode, shipment.carrier_code ?? "");
                const mappedStatus = mapSkydropxShipmentStatus(tracking.orderStatus, tracking.states);

                for (const state of tracking.states) {
                    const occurredAt = new Date(state.datetime);
                    if (Number.isNaN(occurredAt.getTime())) continue;

                    await pool.query(
                        `INSERT INTO Order_shipment_events
                         (os_id, or_id, tracking_code, courier_tracking_code, status, title, description, location, occurred_at, raw_json, event_hash)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE
                           tracking_code = VALUES(tracking_code),
                           courier_tracking_code = VALUES(courier_tracking_code),
                           title = VALUES(title),
                           description = VALUES(description),
                           location = VALUES(location),
                           raw_json = VALUES(raw_json),
                           updated_at = CURRENT_TIMESTAMP`,
                        [
                            Number(shipment.os_id),
                            Number(shipment.or_id),
                            tracking.trackingCode,
                            tracking.courierTrackingCode,
                            state.status,
                            shipmentEventTitle(state.description),
                            shipmentEventDescription(state.description),
                            state.location,
                            occurredAt,
                            JSON.stringify(state.raw ?? null),
                            eventHash(Number(shipment.os_id), state),
                        ]
                    );
                }

                if (mappedStatus) {
                    const orderId = Number(shipment.or_id);
                    syncedStatuses.set(orderId, mappedStatus);

                    await pool.query(
                        `UPDATE Order_shipments
                         SET status = ?, updated_at = CURRENT_TIMESTAMP
                         WHERE os_id = ?`,
                        [mappedStatus, shipment.os_id]
                    );

                    await pool.query(
                        `UPDATE Orders
                         SET shipment_status = ?, update_at = CURRENT_TIMESTAMP
                         WHERE or_id = ?
                           AND (shipment_status IS NULL OR shipment_status != 'delivered')`,
                        [mappedStatus, shipment.or_id]
                    );

                    if (mappedStatus === "delivered") {
                        await pool.query(
                            `UPDATE Orders o
                             LEFT JOIN Status os ON os.s_id = o.s_id
                             LEFT JOIN Status delivered_status ON delivered_status.s_code = 'DELIVERED'
                             SET o.s_id = COALESCE(delivered_status.s_id, o.s_id),
                                 o.status = 'delivered',
                                 o.update_at = CURRENT_TIMESTAMP
                             WHERE o.or_id = ?
                               AND (os.s_code IS NULL OR os.s_code NOT IN ('CANCELLED', 'REFUNDED', 'RETURN_REQUESTED', 'RETURN_REQUESTED_COMPLETED', 'RECEIVED', 'AUTO_RECEIVED', 'REVIEWED'))`,
                            [shipment.or_id]
                        );
                    }
                }
            } catch (error) {
                console.warn("[orders] sync Skydropx tracking failed:", {
                    os_id: shipment.os_id,
                    tracking_code: trackingCode,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    return syncedStatuses;
}

// ดึง event tracking ของ order หลายรายการ แล้วจัดกลุ่มตาม or_id
async function getShipmentEvents(orderIds: number[]): Promise<Map<number, ShipmentEventDTO[]>> {
    await ensureOrderShipmentTables();

    const eventMap = new Map<number, ShipmentEventDTO[]>();
    if (!orderIds.length) return eventMap;

    const [rows] = await pool.query<(RowDataPacket & ShipmentEventDTO & { or_id: number })[]>(
        `SELECT
            ose.or_id,
            ose.status,
            ose.title,
            ose.description,
            ose.location,
            ose.occurred_at
         FROM Order_shipment_events ose
         INNER JOIN (
            SELECT or_id, MAX(os_id) AS os_id
            FROM Order_shipments
            WHERE or_id IN (?)
            GROUP BY or_id
         ) latest_shipment ON latest_shipment.os_id = ose.os_id
         INNER JOIN Order_shipments os ON os.os_id = latest_shipment.os_id
         WHERE ose.or_id IN (?)
           AND (
                os.tracking_no IS NULL
                OR ose.tracking_code = os.tracking_no
                OR ose.courier_tracking_code = os.tracking_no
                OR (ose.tracking_code IS NOT NULL AND os.tracking_url LIKE CONCAT('%', ose.tracking_code, '%'))
                OR (ose.courier_tracking_code IS NOT NULL AND os.tracking_url LIKE CONCAT('%', ose.courier_tracking_code, '%'))
           )
         ORDER BY ose.occurred_at DESC, ose.ose_id DESC`,
        [orderIds, orderIds]
    );

    for (const row of rows) {
        const orderId = Number(row.or_id);
        eventMap.set(orderId, [
            ...(eventMap.get(orderId) ?? []),
            {
                status: row.status ?? null,
                title: row.title,
                description: row.description ?? null,
                location: row.location ?? null,
                occurred_at: String(row.occurred_at),
            },
        ]);
    }

    return eventMap;
}

// ดึงชื่อสถานะตามภาษา ใช้เติม status_label ใน response
async function getStatusLangName(statusCode: string, lgCode: string): Promise<string | null> {
    const [rows] = await pool.query<(RowDataPacket & { s_name: string | null })[]>(
        `SELECT sl.s_name
         FROM Status s
         LEFT JOIN StatusLangs sl ON sl.s_id = s.s_id AND sl.lg_code = ?
         WHERE s.s_code = ?
         LIMIT 1`,
        [lgCode, statusCode]
    );

    return rows[0]?.s_name ?? null;
}

// เช็ค flag สำหรับเปิด action จำลอง shipment ใน dev เท่านั้น
function allowDevShipmentActions() {
    return process.env.ALLOW_DEV_SHIPMENT_ACTIONS === "true";
}

// ดึงข้อมูล shipment และ shipment items ของ order หลายรายการ
async function getOrderShipments(orderIds: number[]): Promise<Map<number, OrderShipmentDTO[]>> {
    await ensureOrderShipmentTables();

    const shipmentMap = new Map<number, OrderShipmentDTO[]>();
    if (!orderIds.length) return shipmentMap;

    const [shipmentRows] = await pool.query<(RowDataPacket & OrderShipmentDTO)[]>(
        `SELECT
            os.os_id,
            os.or_id,
            os.loc_id,
            os.shipment_no,
            os.status,
            os.tracking_no,
            os.tracking_url,
            os.label_url,
            os.sender_name,
            os.sender_phone,
            os.sender_email,
            os.sender_address,
            os.sender_zip_code,
            os.sender_province_name,
            os.sender_district_name,
            os.sender_subdistrict_name,
            os.recipient_name,
            os.recipient_phone,
            os.recipient_address,
            os.recipient_zip_code,
            os.recipient_province_name,
            os.recipient_district_name,
            os.recipient_subdistrict_name,
            COUNT(osi.osi_id) AS item_count,
            COALESCE(SUM(osi.qty), 0) AS total_qty
         FROM Order_shipments os
         LEFT JOIN Order_shipment_items osi ON osi.os_id = os.os_id
         WHERE os.or_id IN (?)
         GROUP BY os.os_id
         ORDER BY os.or_id ASC, os.os_id ASC`,
        [orderIds]
    );

    const [itemRows] = await pool.query<(RowDataPacket & OrderShipmentItemDTO)[]>(
        `SELECT
            osi.osi_id,
            osi.os_id,
            osi.oi_id,
            osi.pv_id,
            oi.sku,
            oi.product_name,
            oi.variant_name,
            osi.qty
         FROM Order_shipment_items osi
         INNER JOIN Order_items oi ON oi.oi_id = osi.oi_id
         WHERE osi.or_id IN (?)
         ORDER BY osi.os_id ASC, osi.osi_id ASC`,
        [orderIds]
    );

    const itemsByShipment = new Map<number, OrderShipmentItemDTO[]>();
    for (const item of itemRows) {
        const shipmentId = Number(item.os_id);
        itemsByShipment.set(shipmentId, [...(itemsByShipment.get(shipmentId) ?? []), item]);
    }

    for (const shipment of shipmentRows) {
        const orderId = Number(shipment.or_id);
        const enriched = {
            ...shipment,
            item_count: Number(shipment.item_count ?? 0),
            total_qty: Number(shipment.total_qty ?? 0),
            items: itemsByShipment.get(Number(shipment.os_id)) ?? [],
        };
        shipmentMap.set(orderId, [...(shipmentMap.get(orderId) ?? []), enriched]);
    }

    return shipmentMap;
}

// คืน usage ของ coupon เมื่อ order ถูกยกเลิกและเคยใช้คูปองไว้
async function restoreCouponUsageForCancelledOrder(conn: PoolConnection, order: OrderDTO): Promise<void> {
    if (!order.co_id) return;

    await conn.query(
        "DELETE FROM CouponRedemptions WHERE or_id = ? AND co_id = ? AND u_id = ?",
        [order.or_id, order.co_id, order.u_id]
    );

    await conn.query(
        "UPDATE Coupon SET used_count = GREATEST(used_count - 1, 0), update_at = ? WHERE co_id = ?",
        [new Date(), order.co_id]
    );

    await conn.query(
        `UPDATE UserCoupons
         SET status = 'claimed',
             used_at = NULL,
             or_id = NULL
         WHERE co_id = ?
           AND u_id = ?
           AND or_id = ?
           AND status = 'used'`,
        [order.co_id, order.u_id, order.or_id]
    );
}

// หา cart ที่ active ของ buyer เพื่อใช้สร้าง order จากตะกร้า
async function getActiveCartId(conn: PoolConnection, uId: number): Promise<number> {
    const [cartRows] = await conn.query<(RowDataPacket & { cart_id: number })[]>(
        "SELECT cart_id FROM Carts WHERE u_id = ? AND status = 'active' ORDER BY cart_id DESC LIMIT 1",
        [uId]
    );
    const cart = cartRows[0];
    if (!cart) throw new ApiError(400, "No hay productos en el carrito.");
    return cart.cart_id;
}

// ดึงสินค้าใน cart พร้อมข้อมูล variant/product/store สำหรับ checkout
async function getCheckoutCartItems(
    conn: PoolConnection,
    cartId: number,
    selectedCiIds: number[] = []
): Promise<CheckoutCartItemRow[]> {
    const useExplicitSelection = selectedCiIds.length > 0;
    const [cartItems] = await conn.query<CheckoutCartItemRow[]>(
        `SELECT
            ci.ci_id,
            ci.pv_id,
            ci.qty,
            ci.unit_price,
            ci.discount_amount,
            ci.line_total,
            pv.pv_sku,
            COALESCE(pv.pv_cost, 0) AS pv_cost,
            pv.weight_g,
            pv.length_cm,
            pv.width_cm,
            pv.height_cm,
            p.p_id,
            p.st_id,
            st.st_company_name,
            pl.p_name,
            GROUP_CONCAT(
                DISTINCT CONCAT(COALESCE(otl.otl_name, ot.otype_name), ': ', poi.poi_value)
                ORDER BY po.otype_id, poi.poi_id
                SEPARATOR ' | '
            ) AS variant_label
        FROM Cart_items ci
        INNER JOIN ProductVariants pv ON pv.pv_id = ci.pv_id
        INNER JOIN Products p ON p.p_id = pv.p_id
        LEFT JOIN Store st ON st.st_id = p.st_id
        LEFT JOIN ProductLangs pl ON pl.p_id = p.p_id AND pl.lg_code = 'es'
        LEFT JOIN VariantOptionItems voi ON voi.pv_id = pv.pv_id
        LEFT JOIN ProductOptionItems poi ON poi.poi_id = voi.poi_id
        LEFT JOIN ProductOptions po ON po.potn_id = poi.potn_id
        LEFT JOIN OptionTypes ot ON ot.otype_id = po.otype_id
        LEFT JOIN OptionTypeLangs otl ON otl.otype_id = ot.otype_id AND otl.lg_code = 'es'
        WHERE ci.cart_id = ?
          ${useExplicitSelection ? "AND ci.ci_id IN (?)" : "AND ci.is_selected = 1"}
        GROUP BY ci.ci_id, ci.pv_id, ci.qty, ci.unit_price, ci.discount_amount,
                 ci.line_total, pv.pv_sku, pv.pv_cost, pv.weight_g, pv.length_cm,
                 pv.width_cm, pv.height_cm, p.p_id, p.st_id, st.st_company_name, pl.p_name`,
        useExplicitSelection ? [cartId, selectedCiIds] : [cartId]
    );

    if (!cartItems.length) throw new ApiError(400, "No hay productos seleccionados en el carrito.");
    return cartItems;
}

async function deleteCheckedOutCartItems(
    conn: PoolConnection,
    cartId: number,
    selectedCiIds: number[] = []
): Promise<void> {
    if (selectedCiIds.length > 0) {
        await conn.query(
            "DELETE FROM Cart_items WHERE cart_id = ? AND ci_id IN (?)",
            [cartId, selectedCiIds]
        );
        return;
    }

    await conn.query(
        "DELETE FROM Cart_items WHERE cart_id = ? AND is_selected = 1",
        [cartId]
    );
}

// ดึงที่อยู่จัดส่งของ buyer สำหรับใช้สร้าง order และคำนวณขนส่ง
async function getCheckoutAddress(conn: PoolConnection, uId: number, locbId: number): Promise<CheckoutAddressRow> {
    const [locRows] = await conn.query<CheckoutAddressRow[]>(
        `SELECT
            lb.locb_recipient_name,
            lb.locb_phone,
            lb.locb_address,
            lb.zip_code,
            lb.state AS province_name,
            COALESCE(lb.municipality, lb.city) AS district_name,
            lb.colonia AS subdistrict_name
         FROM Locations_buyer lb         WHERE lb.locb_id = ? AND lb.u_id = ?
         LIMIT 1`,
        [locbId, uId]
    );
    const loc = locRows[0];
    if (!loc) throw new ApiError(404, "No se encontró la dirección de envío.");
    return loc;
}

// ตรวจว่าคูปองเป็นของร้านใด เพื่อกันใช้คูปองข้ามร้านใน checkout หลายร้าน
async function getCouponStoreId(conn: PoolConnection, coCode: string): Promise<number> {
    const [rows] = await conn.query<(RowDataPacket & { st_id: number })[]>(
        "SELECT st_id FROM Coupon WHERE co_code = ? LIMIT 1",
        [coCode]
    );
    const coupon = rows[0];
    if (!coupon) throw new ApiError(404, "No se encontró el cupón.");
    return Number(coupon.st_id);
}

// แยกสินค้าใน cart ตามร้าน เพราะระบบสร้าง order แยกต่อร้าน
function groupCartItemsByStore(items: CheckoutCartItemRow[]): Map<number, CheckoutCartItemRow[]> {
    const groups = new Map<number, CheckoutCartItemRow[]>();
    for (const item of items) {
        const storeId = Number(item.st_id);
        if (!storeId) throw new ApiError(400, "El producto en el carrito no tiene información de la tienda.");
        groups.set(storeId, [...(groups.get(storeId) ?? []), item]);
    }
    return groups;
}

// รวมขนาด/น้ำหนักสินค้าในร้านเป็น package เดียวสำหรับขอราคา shipping
function buildShippingPackage(items: CheckoutCartItemRow[]) {
    const weightG = items.reduce((sum, item) => {
        return sum + positiveShipmentNumber(item.weight_g, "peso", item.p_name ?? String(item.pv_id)) * Number(item.qty);
    }, 0);

    const lengthCm = items.reduce((sum, item) => sum + positiveShipmentNumber(
        item.length_cm,
        "longitud",
        item.p_name ?? String(item.pv_id)
    ) * Number(item.qty), 0);
    const widthCm = Math.max(...items.map((item) => positiveShipmentNumber(
        item.width_cm,
        "ancho",
        item.p_name ?? String(item.pv_id)
    )));
    const heightCm = Math.max(...items.map((item) => positiveShipmentNumber(
        item.height_cm,
        "altura",
        item.p_name ?? String(item.pv_id)
    )));

    return {
        weight_g: Math.ceil(weightG),
        length_cm: Math.ceil(lengthCm),
        width_cm: Math.ceil(widthCm),
        height_cm: Math.ceil(heightCm),
    };
}

type CheckoutShippingQuoteGroup = {
    loc_id: number;
    origin_postcode: string;
    origin_address: string | null;
    origin_province_name: string | null;
    origin_district_name: string | null;
    origin_subdistrict_name: string | null;
    items: CheckoutCartItemRow[];
};

// สร้างชุด quote ขนส่งของแต่ละร้านใน checkout โดยอิงที่อยู่ buyer และ location ร้าน
async function buildCheckoutShippingQuoteGroups(
    conn: PoolConnection,
    items: CheckoutCartItemRow[]
): Promise<CheckoutShippingQuoteGroup[]> {
    const groups = new Map<number, CheckoutShippingQuoteGroup>();

    for (const item of items) {
        let need = Number(item.qty);

        const [inventoryRows] = await conn.query<(RowDataPacket & {
            inv_id: number;
            loc_id: number;
            on_hand: number;
            reserved_qty: number;
            origin_postcode: string | null;
            origin_address: string | null;
            origin_province_name: string | null;
            origin_district_name: string | null;
            origin_subdistrict_name: string | null;
        })[]>(
            `SELECT
                inv.inv_id,
                inv.loc_id,
                inv.on_hand,
                inv.reserved_qty,
                loc.loc_address AS origin_address,
                loc.zip_code AS origin_postcode,
                loc.state AS origin_province_name,
                COALESCE(loc.municipality, loc.city) AS origin_district_name,
                loc.colonia AS origin_subdistrict_name
             FROM Inventorys inv
             LEFT JOIN Locations loc ON loc.loc_id = inv.loc_id             WHERE inv.pv_id = ?
             ORDER BY inv.inv_id ASC`,
            [item.pv_id]
        );

        for (const row of inventoryRows) {
            if (need <= 0) break;

            const available = Math.max(Number(row.on_hand) - Number(row.reserved_qty), 0);
            const quoteQty = Math.min(need, available);
            if (quoteQty <= 0) continue;

            if (!row.origin_postcode) {
                throw new ApiError(400, "El almacén donde se encuentra el producto no tiene código postal para calcular el envío.");
            }

            const group = groups.get(Number(row.loc_id)) ?? {
                loc_id: Number(row.loc_id),
                origin_postcode: row.origin_postcode,
                origin_address: row.origin_address,
                origin_province_name: row.origin_province_name,
                origin_district_name: row.origin_district_name,
                origin_subdistrict_name: row.origin_subdistrict_name,
                items: [],
            };

            // Quote ต้องใช้จำนวนตามคลังที่คาดว่าจะหยิบจริง ไม่ใช่ qty เต็มของ order item ทุกครั้ง
            group.items.push({ ...item, qty: quoteQty } as CheckoutCartItemRow);
            groups.set(Number(row.loc_id), group);
            need -= quoteQty;
        }

        if (need > 0) {
            throw new ApiError(409, `El producto ${item.p_name ?? item.pv_id} no tiene existencias suficientes para calcular el envío`);
        }
    }

    return Array.from(groups.values());
}

// คำนวณตัวเลือกขนส่งที่ใช้ได้สำหรับตะกร้าปัจจุบัน
async function calculateCheckoutShippingOptions(
    conn: PoolConnection,
    loc: Pick<CheckoutAddressRow, "zip_code" | "locb_address" | "province_name" | "district_name" | "subdistrict_name">,
    items: CheckoutCartItemRow[],
    storeId: number
): Promise<CalculateResult[]> {
    const quoteGroups = await buildCheckoutShippingQuoteGroups(conn, items);
    const groupOptions = await Promise.all(
        quoteGroups.map((group) => {
            const shippingPackage = buildShippingPackage(group.items);
            return shippingService.calculateShipping({
                postcode: loc.zip_code,
                origin_postcode: group.origin_postcode,
                origin_address: group.origin_address,
                origin_province: group.origin_province_name,
                origin_district: group.origin_district_name,
                origin_subdistrict: group.origin_subdistrict_name,
                destination_address: loc.locb_address,
                destination_province: loc.province_name,
                destination_district: loc.district_name,
                destination_subdistrict: loc.subdistrict_name,
                weight_g: shippingPackage.weight_g,
                length_cm: shippingPackage.length_cm,
                width_cm: shippingPackage.width_cm,
                height_cm: shippingPackage.height_cm,
                st_id: storeId,
            });
        })
    );

    // หนึ่งร้านอาจถูกหยิบจากหลายคลัง จึงรวมราคาต่อ carrier ให้เป็นราคาที่ลูกค้าเห็นใน checkout
    return mergeStoreShippingOptions(groupOptions);
}

// รวมตัวเลือกขนส่งจากหลายคลังให้เหลือรายการต่อ carrier
function mergeStoreShippingOptions(storeOptions: CalculateResult[][]): CalculateResult[] {
    if (!storeOptions.length) return [];

    const firstOptions = storeOptions[0] ?? [];
    return firstOptions
        .map((first) => {
            const matched = storeOptions.map((options) => options.find((option) => option.sc_id === first.sc_id));
            if (matched.some((option) => !option || option.price == null)) return { ...first, price: null };

            const totalPrice = matched.reduce((sum, option) => sum + Number(option!.price), 0);
            const billedWeight = matched.reduce((sum, option) => sum + Number(option?.billed_weight_g ?? 0), 0);

            return {
                ...first,
                price: roundMoney(totalPrice),
                billed_weight_g: billedWeight,
            };
        })
        .filter((option) => option.is_active);
}

// เลือก shipping option ตามที่ buyer ส่งมา หรือ fallback เป็นตัวเลือกแรก
// storeName ใช้ระบุในข้อความ error เพื่อบอก buyer ว่าร้านไหนมีปัญหา เมื่อตะกร้ามีหลายร้าน
function pickShippingOption(options: CalculateResult[], shippingScId?: number | null, storeName?: string): CalculateResult {
    const availableOptions = options.filter((option) => option.price != null);
    if (!availableOptions.length) {
        throw new ApiError(400, storeName ? `La tienda "${storeName}" aún no tiene una tarifa de envío disponible para esta dirección` : "Aún no hay una tarifa de envío disponible para esta dirección");
    }

    const selected = shippingScId
        ? availableOptions.find((option) => option.sc_id === shippingScId)
        : null;

    if (shippingScId && !selected) {
        throw new ApiError(400, storeName ? `El método de envío seleccionado para la tienda "${storeName}" no está disponible para esta dirección` : "El método de envío seleccionado no está disponible para esta dirección");
    }

    return selected ?? availableOptions.sort((a, b) => Number(a.price) - Number(b.price))[0]!;
}

// คืนตัวเลือกขนส่งที่ buyer เลือกได้ก่อน checkout แยกเป็นรายร้าน เพราะแต่ละร้านอาจเปิดใช้ขนส่งคนละชุด
export async function getCheckoutShippingOptions(input: {
    u_id: number;
    locb_id: number;
    selected_ci_ids?: number[];
}): Promise<StoreShippingOptions[]> {
    const conn = await pool.getConnection();
    try {
        const cartId = await getActiveCartId(conn, input.u_id);
        const [items, loc] = await Promise.all([
            getCheckoutCartItems(conn, cartId, input.selected_ci_ids ?? []),
            getCheckoutAddress(conn, input.u_id, input.locb_id),
        ]);

        const storeGroups = Array.from(groupCartItemsByStore(items).entries());
        return await Promise.all(
            storeGroups.map(async ([storeId, storeItems]) => ({
                st_id: storeId,
                st_company_name: storeItems[0]?.st_company_name ?? "",
                options: await calculateCheckoutShippingOptions(conn, loc, storeItems, storeId),
            }))
        );
    } finally {
        conn.release();
    }
}

// สร้าง order จาก cart โดยยังไม่ charge เงิน ใช้กับ flow แยกจ่ายภายหลัง
export async function createOrder(input: CreateOrderInput): Promise<OrderDetailDTO[]> {
    await ensureInventoryReservationTable();
    await ensureOrderShipmentLabelColumn();
    await ensureOrderShipmentTables();

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // ดึง active cart
        const cartId = await getActiveCartId(conn, input.u_id);

        // ดึง cart items พร้อมข้อมูลสินค้า
        const cartItems = await getCheckoutCartItems(conn, cartId, input.selected_ci_ids ?? []);

        // ดึง shipping address
        const loc = await getCheckoutAddress(conn, input.u_id, input.locb_id);

        const storeGroups = Array.from(groupCartItemsByStore(cartItems).entries());
        const pendingStatusId = await getOrderStatusId(conn, "PENDING");
        const couponStoreId = input.co_code ? await getCouponStoreId(conn, input.co_code) : null;
        if (couponStoreId && !storeGroups.some(([storeId]) => storeId === couponStoreId)) {
            throw new ApiError(400, "Este cupón no se puede aplicar a los productos seleccionados en el carrito.");
        }
        const createdOrderIds: number[] = [];
        const reservationItems: InventoryReservationItem[] = [];

        for (const [storeId, storeItems] of storeGroups) {
            const subtotal = roundMoney(storeItems.reduce((sum, i) => sum + Number(i.line_total), 0));
            const shippingOptions = await calculateCheckoutShippingOptions(conn, loc, storeItems, storeId);
            const scIdForStore = input.shipping_selections?.find((s) => s.st_id === storeId)?.sc_id ?? null;
            const shippingOption = pickShippingOption(shippingOptions, scIdForStore, storeItems[0]?.st_company_name ?? undefined);
            const shippingFee = Number(shippingOption.price ?? 0);
            const providerShippingCost = shippingOption.provider_price == null ? null : Number(shippingOption.provider_price);

            const couponResult = input.co_code && couponStoreId === storeId
                ? await couponService.validateCouponForCheckout(conn, {
                    u_id: input.u_id,
                    co_code: input.co_code,
                    st_id: storeId,
                })
                : null;

            const discountTotal = couponResult?.discount_amount ?? 0;
            const grandTotal = roundMoney(subtotal + shippingFee - discountTotal);
            const orderNo = await generateOrderNo(conn);

            const [orderRes] = await conn.query<ResultSetHeader>(
                "INSERT INTO Orders SET ?",
                [{
                    order_no: orderNo,
                    u_id: input.u_id,
                    cart_id: cartId,
                    co_id: couponResult?.coupon.co_id ?? null,
                    st_id: storeId,
                    s_id: pendingStatusId,
                    status: toLegacyOrderStatus("PENDING"),
                    subtotal,
                    discount_total: discountTotal,
                    shipping_fee: shippingFee,
                    provider_shipping_cost: providerShippingCost,
                    // Snapshot carrier choice on the order; without this we cannot reliably show
                    // which shipping provider the buyer selected after checkout.
                    shipping_sc_id: shippingOption.sc_id,
                    grand_total: grandTotal,
                    coupon_code: couponResult?.coupon.co_code ?? null,
                    shipping_name: loc.locb_recipient_name,
                    shipping_phone: loc.locb_phone,
                    shipping_address: loc.locb_address,
                    remark: null,
                    payment_expires_at: buildPaymentExpiresAt(),
                    created_at: new Date(),
                    update_at: new Date(),
                }]
            );
            const orId = orderRes.insertId;
            createdOrderIds.push(orId);

            for (const item of storeItems) {
                const [itemRes] = await conn.query<ResultSetHeader>(
                    "INSERT INTO Order_items SET ?",
                    [{
                        or_id: orId,
                        p_id: item.p_id,
                        pv_id: item.pv_id,
                        sku: item.pv_sku ?? null,
                        product_name: item.p_name ?? "",
                        variant_name: item.variant_label ?? null,
                        unit_price: Number(item.unit_price),
                        discount_amount: Number(item.discount_amount),
                        qty: item.qty,
                        line_total: Number(item.line_total),
                        cost_snapshot: Number(item.pv_cost),
                        created_at: new Date(),
                    }]
                );

                reservationItems.push({
                    or_id: orId,
                    oi_id: itemRes.insertId,
                    pv_id: item.pv_id,
                    qty: item.qty,
                    order_no: orderNo,
                });
            }

            if (couponResult) {
                await couponService.redeemCouponForCheckout(conn, {
                    u_id: input.u_id,
                    or_id: orId,
                    co_id: couponResult.coupon.co_id,
                    co_code_snapshot: couponResult.coupon.co_code,
                    subtotal_amount: couponResult.subtotal_amount,
                    discount_amount: couponResult.discount_amount,
                });
            }
        }

        // สร้าง order pending แล้วต้องกัน stock ทันที เพื่อไม่ให้ลูกค้าคนอื่นซื้อเกิน available_qty
        await reserveInventoryForOrderItems(conn, reservationItems);
        await createShipmentGroupsForOrders(conn, createdOrderIds);

        // เอาออกเฉพาะรายการที่ถูกเลือกไปสร้าง order แล้ว รายการที่ไม่เลือกต้องอยู่ใน cart ต่อ
        await deleteCheckedOutCartItems(conn, cartId, input.selected_ci_ids ?? []);

        const [remainingRows] = await conn.query<(RowDataPacket & { cnt: number })[]>(
            "SELECT COUNT(*) AS cnt FROM Cart_items WHERE cart_id = ?",
            [cartId]
        );

        await conn.query(
            "UPDATE Carts SET status = ?, updated_at = ? WHERE cart_id = ?",
            [Number(remainingRows[0]?.cnt ?? 0) > 0 ? "active" : "checked_out", new Date(), cartId]
        );

        await conn.commit();

        const orders: OrderDetailDTO[] = [];
        const shipmentMap = await getOrderShipments(createdOrderIds);
        for (const orId of createdOrderIds) {
            const [orderRows] = await conn.query<(RowDataPacket & OrderDTO)[]>(
                `${orderSelectSql} WHERE o.or_id = ?`,
                ["es", orId]
            );

            const [itemRows] = await conn.query<(RowDataPacket & OrderItemDTO)[]>(
                `${orderItemsSelectSql} WHERE oi.or_id = ? ORDER BY oi.oi_id ASC`,
                ["es", orId]
            );

            orders.push({ ...orderRows[0]!, items: itemRows, shipments: shipmentMap.get(orId) ?? [] });
        }

        await notifyManyOrderEvents(orders.map((order) => ({
            event: "order:created",
            order,
            actor: "buyer",
            targets: ["STORE"],
            title: "Nuevo pedido",
            message: `El pedido ${order.order_no} está pendiente de pago por un total de ${Number(order.grand_total).toLocaleString("es-MX", { style: "currency", currency: "MXN" })}.`,
            priority: "HIGH",
        })));

        return orders;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// checkout แบบครบวงจร: สร้าง order, reserve stock, ใช้คูปอง และสร้าง payment
export async function checkoutOrder(input: CheckoutOrderInput): Promise<{ orders: OrderDetailDTO[]; payment: PaymentResultDTO }> {
    await ensureInventoryReservationTable();
    await ensureOrderShipmentLabelColumn();
    await ensureOrderShipmentTables();

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Checkout แบบจ่ายเงินใน transaction เดียว:
        // ถ้าบัตรถูกปฏิเสธ transaction จะ rollback ทำให้ไม่เกิด order และ cart ยังอยู่เหมือนเดิม
        const cartId = await getActiveCartId(conn, input.u_id);
        const cartItems = await getCheckoutCartItems(conn, cartId, input.selected_ci_ids ?? []);
        const loc = await getCheckoutAddress(conn, input.u_id, input.locb_id);

        const storeGroups = Array.from(groupCartItemsByStore(cartItems).entries());
        const pendingStatusId = await getOrderStatusId(conn, "PENDING");
        const couponStoreId = input.co_code ? await getCouponStoreId(conn, input.co_code) : null;
        if (couponStoreId && !storeGroups.some(([storeId]) => storeId === couponStoreId)) {
            throw new ApiError(400, "Este cupón no se puede aplicar a los productos seleccionados en el carrito.");
        }

        const createdOrderIds: number[] = [];
        const reservationItems: InventoryReservationItem[] = [];

        for (const [storeId, storeItems] of storeGroups) {
            const subtotal = roundMoney(storeItems.reduce((sum, i) => sum + Number(i.line_total), 0));
            const shippingOptions = await calculateCheckoutShippingOptions(conn, loc, storeItems, storeId);
            const scIdForStore = input.shipping_selections?.find((s) => s.st_id === storeId)?.sc_id ?? null;
            const shippingOption = pickShippingOption(shippingOptions, scIdForStore, storeItems[0]?.st_company_name ?? undefined);
            const shippingFee = Number(shippingOption.price ?? 0);
            const providerShippingCost = shippingOption.provider_price == null ? null : Number(shippingOption.provider_price);

            const couponResult = input.co_code && couponStoreId === storeId
                ? await couponService.validateCouponForCheckout(conn, {
                    u_id: input.u_id,
                    co_code: input.co_code,
                    st_id: storeId,
                })
                : null;

            const discountTotal = couponResult?.discount_amount ?? 0;
            const grandTotal = roundMoney(subtotal + shippingFee - discountTotal);
            const orderNo = await generateOrderNo(conn);

            const [orderRes] = await conn.query<ResultSetHeader>(
                "INSERT INTO Orders SET ?",
                [{
                    order_no: orderNo,
                    u_id: input.u_id,
                    cart_id: cartId,
                    co_id: couponResult?.coupon.co_id ?? null,
                    st_id: storeId,
                    s_id: pendingStatusId,
                    status: toLegacyOrderStatus("PENDING"),
                    subtotal,
                    discount_total: discountTotal,
                    shipping_fee: shippingFee,
                    provider_shipping_cost: providerShippingCost,
                    // Snapshot carrier choice on the order; without this we cannot reliably show
                    // which shipping provider the buyer selected after checkout.
                    shipping_sc_id: shippingOption.sc_id,
                    grand_total: grandTotal,
                    coupon_code: couponResult?.coupon.co_code ?? null,
                    shipping_name: loc.locb_recipient_name,
                    shipping_phone: loc.locb_phone,
                    shipping_address: loc.locb_address,
                    remark: null,
                    payment_expires_at: buildPaymentExpiresAt(),
                    created_at: new Date(),
                    update_at: new Date(),
                }]
            );
            const orId = orderRes.insertId;
            createdOrderIds.push(orId);

            for (const item of storeItems) {
                const [itemRes] = await conn.query<ResultSetHeader>(
                    "INSERT INTO Order_items SET ?",
                    [{
                        or_id: orId,
                        p_id: item.p_id,
                        pv_id: item.pv_id,
                        sku: item.pv_sku ?? null,
                        product_name: item.p_name ?? "",
                        variant_name: item.variant_label ?? null,
                        unit_price: Number(item.unit_price),
                        discount_amount: Number(item.discount_amount),
                        qty: item.qty,
                        line_total: Number(item.line_total),
                        cost_snapshot: Number(item.pv_cost),
                        created_at: new Date(),
                    }]
                );

                reservationItems.push({
                    or_id: orId,
                    oi_id: itemRes.insertId,
                    pv_id: item.pv_id,
                    qty: item.qty,
                    order_no: orderNo,
                });
            }

            if (couponResult) {
                await couponService.redeemCouponForCheckout(conn, {
                    u_id: input.u_id,
                    or_id: orId,
                    co_id: couponResult.coupon.co_id,
                    co_code_snapshot: couponResult.coupon.co_code,
                    subtotal_amount: couponResult.subtotal_amount,
                    discount_amount: couponResult.discount_amount,
                });
            }
        }

        // Checkout Pro ยืนยันการชำระผ่าน webhook ภายหลัง จึง reserve stock ก่อน redirect
        await reserveInventoryForOrderItems(conn, reservationItems);
        await createShipmentGroupsForOrders(conn, createdOrderIds);

        const [orderRows] = await conn.query<(RowDataPacket & Pick<OrderDTO, "or_id" | "order_no" | "grand_total">)[]>(
            "SELECT or_id, order_no, grand_total FROM Orders WHERE or_id IN (?) ORDER BY or_id ASC",
            [createdOrderIds]
        );

        const payment = await chargeAndRecordPayment(conn, {
            u_id: input.u_id,
            payment_method: input.payment_method,
            orders: orderRows.map((order) => ({
                or_id: Number(order.or_id),
                order_no: String(order.order_no),
                grand_total: Number(order.grand_total),
            })),
        });

        if (payment.payment_status === "failed") {
            throw new ApiError(400, "El pago no se pudo procesar. Inténtalo de nuevo.");
        }

        // ลบ cart เฉพาะหลัง payment step ผ่านแล้วเท่านั้น
        await deleteCheckedOutCartItems(conn, cartId, input.selected_ci_ids ?? []);

        const [remainingRows] = await conn.query<(RowDataPacket & { cnt: number })[]>(
            "SELECT COUNT(*) AS cnt FROM Cart_items WHERE cart_id = ?",
            [cartId]
        );

        await conn.query(
            "UPDATE Carts SET status = ?, updated_at = ? WHERE cart_id = ?",
            [Number(remainingRows[0]?.cnt ?? 0) > 0 ? "active" : "checked_out", new Date(), cartId]
        );

        await conn.commit();

        const orders: OrderDetailDTO[] = [];
        const shipmentMap = await getOrderShipments(createdOrderIds);
        for (const orId of createdOrderIds) {
            const [finalOrderRows] = await conn.query<(RowDataPacket & OrderDTO)[]>(
                `${orderSelectSql} WHERE o.or_id = ?`,
                ["es", orId]
            );

            const [itemRows] = await conn.query<(RowDataPacket & OrderItemDTO)[]>(
                `${orderItemsSelectSql} WHERE oi.or_id = ? ORDER BY oi.oi_id ASC`,
                ["es", orId]
            );

            orders.push({ ...finalOrderRows[0]!, items: itemRows, shipments: shipmentMap.get(orId) ?? [] });
        }

        await notifyManyOrderEvents(orders.map((order) => {
            const isPaid = payment.payment_status === "paid";
            return {
                event: isPaid ? "order:paid" : "order:created",
                order,
                actor: "buyer",
                targets: ["STORE"],
                title: isPaid ? "Pago completado" : "Nuevo pedido",
                message: isPaid
                    ? `El pedido ${order.order_no} ha sido pagado por un total de ${Number(order.grand_total).toLocaleString("es-MX", { style: "currency", currency: "MXN" })}.`
                    : `El pedido ${order.order_no} está pendiente de pago por un total de ${Number(order.grand_total).toLocaleString("es-MX", { style: "currency", currency: "MXN" })}.`,
                priority: isPaid ? "HIGH" : "NORMAL",
            } satisfies OrderNotificationOptions;
        }));

        return { orders, payment };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// ดึงรายการ order ของ buyer พร้อม items และ shipment events สำหรับหน้า "การซื้อของฉัน"
export async function getOrders(u_id: number, lg_code = "es"): Promise<(OrderDTO & { item_count: number; items: OrderItemDTO[] })[]> {
    await ensureOrderShipmentLabelColumn();

    const [rows] = await pool.query<(RowDataPacket & OrderDTO & { item_count: number })[]>(
        `SELECT
            o.or_id, o.order_no, o.u_id, o.cart_id, o.co_id, o.st_id, o.s_id,
            s.st_company_name,
            o.status, os.s_code AS status_code, osl.s_name AS status_label,
            latest_refund.refund_id AS refund_id,
            latest_refund.amount AS refund_amount,
            latest_refund.remark AS refund_remark,
            latest_refund.return_tracking AS return_tracking,
            latest_refund.updated_at AS refund_updated_at,
            latest_refund.status AS refund_status,
            o.subtotal, o.discount_total, o.shipping_fee,
            o.provider_shipping_cost,
            o.shipping_sc_id,
            sc.sc_code AS shipping_carrier_code,
            sc.sc_name AS shipping_carrier_name,
            o.tracking_no,
            o.tracking_url,
            o.label_url,
            sc.tracking_url_template,
            o.shipment_status,
            o.grand_total, o.coupon_code,
            o.shipping_name, o.shipping_phone, o.shipping_address,
            lb.zip_code AS shipping_zip_code,
            lb.country_code AS shipping_country_code,
            lb.state AS shipping_state,
            lb.city AS shipping_city,
            lb.municipality AS shipping_municipality,
            lb.colonia AS shipping_colonia,
            lb.state AS shipping_province_name,
            COALESCE(lb.municipality, lb.city) AS shipping_district_name,
            lb.colonia AS shipping_subdistrict_name,
            o.remark, o.payment_expires_at, o.created_at, o.update_at,
            COUNT(oi.oi_id) AS item_count
        FROM Orders o
        LEFT JOIN Store s ON s.st_id = o.st_id
        LEFT JOIN Shipping_carriers sc ON sc.sc_id = o.shipping_sc_id
        LEFT JOIN Status os ON os.s_id = o.s_id
        LEFT JOIN StatusLangs osl ON osl.s_id = os.s_id AND osl.lg_code = ?
        LEFT JOIN Locations_buyer lb
            ON lb.u_id = o.u_id
           AND lb.locb_recipient_name = o.shipping_name
           AND lb.locb_phone = o.shipping_phone
           AND lb.locb_address = o.shipping_address        LEFT JOIN (
            SELECT r1.or_id, r1.refund_id, r1.amount, r1.status, r1.remark, r1.return_tracking, r1.updated_at
            FROM Refunds r1
            INNER JOIN (
                SELECT or_id, MAX(refund_id) AS refund_id
                FROM Refunds
                GROUP BY or_id
            ) latest ON latest.refund_id = r1.refund_id
        ) latest_refund ON latest_refund.or_id = o.or_id
        LEFT JOIN Order_items oi ON oi.or_id = o.or_id
        WHERE o.u_id = ?
        GROUP BY o.or_id
        ORDER BY o.created_at DESC`,
        [lg_code, u_id]
    );
    const orderIds = rows.map((order) => Number(order.or_id));
    let syncedStatuses = new Map<number, string>();
    const syncOnList = process.env.SKYDROPX_TRACKING_SYNC_ON_LIST;
    if (syncOnList === "true") {
        syncedStatuses = await syncShipmentEventsFromProvider(orderIds);
    }
    const [itemMap, eventMap] = await Promise.all([
        getOrderItems(orderIds, lg_code),
        getShipmentEvents(orderIds),
    ]);
    const deliveredStatusLabel = [...syncedStatuses.values()].includes("delivered")
        ? await getStatusLangName("DELIVERED", lg_code)
        : null;
    return rows.map((order) => {
        const syncedStatus = syncedStatuses.get(Number(order.or_id));
        const orderStatusCode = order.status_code as OrderStatusCode | null;
        const shouldApplyDeliveredSync = syncedStatus === "delivered" && !ORDER_RECEIVED_STATUS_CODES.includes(orderStatusCode as OrderStatusCode);
        return {
            ...order,
            status: shouldApplyDeliveredSync ? "delivered" : order.status,
            status_code: (shouldApplyDeliveredSync ? "DELIVERED" : order.status_code ?? null) as string | null,
            status_label: (shouldApplyDeliveredSync ? deliveredStatusLabel : order.status_label ?? null) as string | null,
            shipment_status: (syncedStatus ?? order.shipment_status ?? null) as string | null,
            items: itemMap.get(Number(order.or_id)) ?? [],
            shipment_events: eventMap.get(Number(order.or_id)) ?? [],
        };
    });
}

// ดึงรายการ order ฝั่งร้าน/backoffice ตามร้านที่ login อยู่
export async function adminGetOrders(st_id: number, lg_code = "es"): Promise<AdminOrderDTO[]> {
    await ensureOrderShipmentLabelColumn();
    await ensureRefundMethodColumn();

    const params: number[] = [];
    const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "WHERE o.st_id = ?";
    if (storeSql) params.push(st_id);

    const [rows] = await pool.query<(RowDataPacket & AdminOrderDTO)[]>(
        `SELECT
            o.or_id, o.order_no, o.u_id, o.cart_id, o.co_id, o.st_id, o.s_id,
            s.st_company_name,
            s.is_platform_store AS st_is_platform_store,
            COALESCE(NULLIF(u.u_username, ''), o.shipping_name, CONCAT('Customer #', o.u_id)) AS customer_name,
            o.status, os.s_code AS status_code, osl.s_name AS status_label,
            latest_refund.refund_id AS refund_id,
            latest_refund.amount AS refund_amount,
            latest_refund.remark AS refund_remark,
            latest_refund.return_tracking AS return_tracking,
            latest_refund.updated_at AS refund_updated_at,
            latest_refund.status AS refund_status,
            latest_refund.refund_method AS refund_method,
            o.subtotal, o.discount_total, o.shipping_fee,
            o.provider_shipping_cost,
            o.shipping_sc_id,
            sc.sc_code AS shipping_carrier_code,
            sc.sc_name AS shipping_carrier_name,
            o.tracking_no,
            o.tracking_url,
            o.label_url,
            sc.tracking_url_template,
            o.shipment_status,
            o.grand_total, o.coupon_code,
            o.shipping_name, o.shipping_phone, o.shipping_address,
            lb.zip_code AS shipping_zip_code,
            lb.country_code AS shipping_country_code,
            lb.state AS shipping_state,
            lb.city AS shipping_city,
            lb.municipality AS shipping_municipality,
            lb.colonia AS shipping_colonia,
            lb.state AS shipping_province_name,
            COALESCE(lb.municipality, lb.city) AS shipping_district_name,
            lb.colonia AS shipping_subdistrict_name,
            o.remark, o.payment_expires_at, o.created_at, o.update_at,
            COUNT(oi.oi_id) AS item_count
        FROM Orders o
        LEFT JOIN Store s ON s.st_id = o.st_id
        LEFT JOIN Shipping_carriers sc ON sc.sc_id = o.shipping_sc_id
        LEFT JOIN Status os ON os.s_id = o.s_id
        LEFT JOIN StatusLangs osl ON osl.s_id = os.s_id AND osl.lg_code = ?
        LEFT JOIN (
            SELECT r1.or_id, r1.refund_id, r1.amount, r1.status, r1.remark, r1.return_tracking, r1.updated_at, r1.refund_method
            FROM Refunds r1
            INNER JOIN (
                SELECT or_id, MAX(refund_id) AS refund_id
                FROM Refunds
                GROUP BY or_id
            ) latest ON latest.refund_id = r1.refund_id
        ) latest_refund ON latest_refund.or_id = o.or_id
        LEFT JOIN Users u ON u.u_id = o.u_id
        LEFT JOIN Locations_buyer lb
            ON lb.u_id = o.u_id
           AND lb.locb_recipient_name = o.shipping_name
           AND lb.locb_phone = o.shipping_phone
           AND lb.locb_address = o.shipping_address        LEFT JOIN Order_items oi ON oi.or_id = o.or_id
        ${storeSql}
        GROUP BY o.or_id
        ORDER BY o.created_at DESC`,
        [lg_code, ...params]
    );

    return rows;
}

// สรุปยอด order หน้า dashboard ร้าน เช่น ยอดขายวันนี้และจำนวน order ตามสถานะ
export async function adminGetOrderSummary(st_id: number): Promise<AdminOrderSummaryDTO> {
    const params: number[] = [];
    const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "WHERE st_id = ?";
    if (storeSql) params.push(st_id);

    const [rows] = await pool.query<(RowDataPacket & AdminOrderSummaryDTO)[]>(
        `SELECT
            COALESCE(SUM(CASE
                WHEN DATE(o.created_at) = CURDATE()
                     AND os.s_code IN ('CONFIRMED', 'PROCESSING', 'PACKED', 'READY_TO_SHIP')
                THEN o.grand_total ELSE 0
            END), 0) AS today_sales,
            COALESCE(SUM(CASE WHEN DATE(o.created_at) = CURDATE() THEN 1 ELSE 0 END), 0) AS new_orders,
            COALESCE(SUM(CASE WHEN os.s_code = 'CONFIRMED' THEN 1 ELSE 0 END), 0) AS pending_orders,
            COALESCE(SUM(CASE WHEN os.s_code IN ('PROCESSING', 'PACKED') THEN 1 ELSE 0 END), 0) AS packing_orders,
            COALESCE(SUM(CASE WHEN os.s_code = 'READY_TO_SHIP' THEN 1 ELSE 0 END), 0) AS shipped_orders,
            COALESCE(SUM(o.discount_total), 0) AS coupon_discount_total
        FROM Orders o
        LEFT JOIN Status os ON os.s_id = o.s_id
        ${storeSql ? "WHERE o.st_id = ?" : ""}`,
        params
    );

    const summary = rows[0];
    return {
        today_sales: Number(summary?.today_sales ?? 0),
        new_orders: Number(summary?.new_orders ?? 0),
        pending_orders: Number(summary?.pending_orders ?? 0),
        packing_orders: Number(summary?.packing_orders ?? 0),
        shipped_orders: Number(summary?.shipped_orders ?? 0),
        coupon_discount_total: Number(summary?.coupon_discount_total ?? 0),
    };
}

// รายงานยอดขายรวมตามช่วงวันที่ของร้าน ใช้ดูภาพรวมราย order
export async function adminGetSalesReport(
    st_id: number,
    filters: { start_date?: string; end_date?: string; lg_code?: string } = {}
): Promise<AdminSalesReportDTO> {
    await ensureOrderShipmentTables();

    const params: (number | string)[] = [filters.lg_code ?? "es"];
    const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
    if (storeSql) params.push(st_id);

    const dateSql: string[] = [];
    if (filters.start_date) {
        dateSql.push("DATE(o.update_at) >= ?");
        params.push(filters.start_date);
    }
    if (filters.end_date) {
        dateSql.push("DATE(o.update_at) <= ?");
        params.push(filters.end_date);
    }

    const [rows] = await pool.query<(RowDataPacket & AdminSalesReportRowDTO)[]>(
        `SELECT
            o.or_id,
            o.order_no,
            o.st_id,
            st.st_company_name,
            COALESCE(NULLIF(u.u_username, ''), o.shipping_name, CONCAT('Customer #', o.u_id)) AS customer_name,
            os.s_code AS status_code,
            osl.s_name AS status_label,
            o.update_at AS sale_date,
            COALESCE(item_summary.item_count, 0) AS item_count,
            COALESCE(item_summary.item_gross_total, o.subtotal) AS subtotal,
            COALESCE(o.discount_total, 0) + COALESCE(item_summary.item_discount_total, 0) AS discount_total,
            o.shipping_fee,
            o.provider_shipping_cost,
            o.grand_total,
            COALESCE(refund.refund_total, 0) AS refund_total,
            GREATEST(o.grand_total - COALESCE(refund.refund_total, 0), 0) AS net_sales,
            pay.payment_method,
            pay.payment_status
        FROM Orders o
        LEFT JOIN Users u ON u.u_id = o.u_id
        LEFT JOIN Store st ON st.st_id = o.st_id
        LEFT JOIN Status os ON os.s_id = o.s_id
        LEFT JOIN StatusLangs osl ON osl.s_id = os.s_id AND osl.lg_code = ?
        LEFT JOIN (
            SELECT
                or_id,
                COUNT(oi_id) AS item_count,
                SUM(unit_price * qty) AS item_gross_total,
                SUM(discount_amount * qty) AS item_discount_total
            FROM Order_items
            GROUP BY or_id
        ) item_summary ON item_summary.or_id = o.or_id
        LEFT JOIN (
            SELECT
                po.or_id,
                MAX(p.paid_at) AS paid_at,
                MAX(p.payment_method) AS payment_method,
                MAX(p.payment_status) AS payment_status
            FROM Payment_orders po
            INNER JOIN Payments p ON p.pay_id = po.pay_id
            WHERE p.payment_status = 'paid'
            GROUP BY po.or_id
        ) pay ON pay.or_id = o.or_id
        LEFT JOIN (
            SELECT
                or_id,
                MAX(occurred_at) AS delivered_at
            FROM Order_shipment_events
            WHERE status = 'POD'
               OR LOWER(COALESCE(description, '')) LIKE '%delivery successfully%'
            GROUP BY or_id
        ) delivered_event ON delivered_event.or_id = o.or_id
        LEFT JOIN (
            SELECT or_id, SUM(amount) AS refund_total
            FROM Refunds
            WHERE status = 'succeeded'
            GROUP BY or_id
        ) refund ON refund.or_id = o.or_id
        WHERE os.s_code IN ('RECEIVED', 'AUTO_RECEIVED', 'REVIEWED')
            ${storeSql}
            ${dateSql.length ? `AND ${dateSql.join(" AND ")}` : ""}
        GROUP BY
            o.or_id, o.order_no, o.st_id, st.st_company_name, customer_name,
            os.s_code, osl.s_name, sale_date, item_summary.item_count,
            item_summary.item_gross_total, item_summary.item_discount_total, o.subtotal, o.discount_total,
            o.shipping_fee, o.provider_shipping_cost, o.grand_total, refund.refund_total,
            pay.payment_method, pay.payment_status
        ORDER BY sale_date DESC, o.or_id DESC`,
        params
    );

    const summary = rows.reduce(
        (total, row) => {
            total.order_count += 1;
            total.item_count += Number(row.item_count ?? 0);
            total.subtotal += Number(row.subtotal ?? 0);
            total.discount_total += Number(row.discount_total ?? 0);
            total.shipping_fee += Number(row.shipping_fee ?? 0);
            total.gross_sales += Number(row.subtotal ?? 0) + Number(row.shipping_fee ?? 0);
            total.refund_total += Number(row.refund_total ?? 0);
            total.net_sales += Number(row.net_sales ?? 0);
            return total;
        },
        {
            order_count: 0,
            item_count: 0,
            subtotal: 0,
            discount_total: 0,
            shipping_fee: 0,
            gross_sales: 0,
            refund_total: 0,
            net_sales: 0,
            average_order_value: 0,
        }
    );

    summary.average_order_value = summary.order_count > 0 ? summary.net_sales / summary.order_count : 0;

    return {
        summary,
        rows: rows.map((row) => ({
            ...row,
            item_count: Number(row.item_count ?? 0),
            subtotal: Number(row.subtotal ?? 0),
            discount_total: Number(row.discount_total ?? 0),
            shipping_fee: Number(row.shipping_fee ?? 0),
            grand_total: Number(row.grand_total ?? 0),
            refund_total: Number(row.refund_total ?? 0),
            net_sales: Number(row.net_sales ?? 0),
        })),
    };
}

// รายงานยอดขายแยกตามสินค้าและ variant
export async function adminGetSalesByProductReport(
    st_id: number,
    filters: { start_date?: string; end_date?: string; lg_code?: string } = {}
): Promise<AdminSalesByProductReportDTO> {
    await ensureOrderShipmentTables();

    const params: (number | string)[] = [filters.lg_code ?? "es"];
    const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
    if (storeSql) params.push(st_id);

    const dateSql: string[] = [];
    if (filters.start_date) {
        dateSql.push("DATE(o.update_at) >= ?");
        params.push(filters.start_date);
    }
    if (filters.end_date) {
        dateSql.push("DATE(o.update_at) <= ?");
        params.push(filters.end_date);
    }

    const [rows] = await pool.query<(RowDataPacket & AdminSalesByProductRowDTO)[]>(
        `SELECT
            oi.p_id,
            oi.pv_id,
            oi.sku,
            COALESCE(pl.p_name, oi.product_name) AS product_name,
            oi.variant_name,
            p.st_id,
            st.st_company_name,
            COUNT(DISTINCT CASE
                WHEN GREATEST(oi.qty - COALESCE(refund_item.refund_qty, 0), 0) > 0
                  OR GREATEST(oi.line_total - COALESCE(refund_item.refund_amount, 0), 0) > 0
                THEN o.or_id
                ELSE NULL
            END) AS order_count,
            SUM(GREATEST(oi.qty - COALESCE(refund_item.refund_qty, 0), 0)) AS qty_sold,
            SUM(oi.unit_price * GREATEST(oi.qty - COALESCE(refund_item.refund_qty, 0), 0)) AS gross_sales,
            SUM(oi.discount_amount * GREATEST(oi.qty - COALESCE(refund_item.refund_qty, 0), 0)) AS discount_total,
            SUM(GREATEST(oi.line_total - COALESCE(refund_item.refund_amount, 0), 0)) AS net_sales,
            CASE
                WHEN SUM(GREATEST(oi.qty - COALESCE(refund_item.refund_qty, 0), 0)) > 0
                THEN SUM(GREATEST(oi.line_total - COALESCE(refund_item.refund_amount, 0), 0)) / SUM(GREATEST(oi.qty - COALESCE(refund_item.refund_qty, 0), 0))
                ELSE 0
            END AS average_unit_price
        FROM Order_items oi
        INNER JOIN Orders o ON o.or_id = oi.or_id
        INNER JOIN Status os ON os.s_id = o.s_id
        LEFT JOIN Products p ON p.p_id = oi.p_id
        LEFT JOIN ProductLangs pl ON pl.p_id = oi.p_id AND pl.lg_code = ?
        LEFT JOIN Store st ON st.st_id = p.st_id
        LEFT JOIN (
            SELECT
                ri.oi_id,
                SUM(ri.qty) AS refund_qty,
                SUM(ri.amount) AS refund_amount
            FROM Refund_items ri
            INNER JOIN Refunds r ON r.refund_id = ri.refund_id
            WHERE r.status = 'succeeded'
            GROUP BY ri.oi_id
        ) refund_item ON refund_item.oi_id = oi.oi_id
        LEFT JOIN (
            SELECT
                or_id,
                MAX(occurred_at) AS delivered_at
            FROM Order_shipment_events
            WHERE status = 'POD'
               OR LOWER(COALESCE(description, '')) LIKE '%delivery successfully%'
            GROUP BY or_id
        ) delivered_event ON delivered_event.or_id = o.or_id
        WHERE os.s_code IN ('RECEIVED', 'AUTO_RECEIVED', 'REVIEWED')
            ${storeSql}
            ${dateSql.length ? `AND ${dateSql.join(" AND ")}` : ""}
        GROUP BY
            oi.p_id, oi.pv_id, oi.sku, product_name, oi.variant_name,
            p.st_id, st.st_company_name
        HAVING qty_sold > 0 OR net_sales > 0
        ORDER BY net_sales DESC, qty_sold DESC`,
        params
    );

    // รายงานนี้ไม่คำนวณกำไร เพราะระบบไม่เก็บต้นทุนตามนโยบายความปลอดภัยของร้านค้า
    const normalizedRows = rows.map((row) => ({
        ...row,
        p_id: Number(row.p_id ?? 0),
        pv_id: Number(row.pv_id ?? 0),
        st_id: row.st_id === null ? null : Number(row.st_id ?? 0),
        order_count: Number(row.order_count ?? 0),
        qty_sold: Number(row.qty_sold ?? 0),
        gross_sales: Number(row.gross_sales ?? 0),
        discount_total: Number(row.discount_total ?? 0),
        net_sales: Number(row.net_sales ?? 0),
        average_unit_price: Number(row.average_unit_price ?? 0),
    }));

    const summary = normalizedRows.reduce(
        (total, row) => {
            total.product_count += 1;
            total.order_count += row.order_count;
            total.qty_sold += row.qty_sold;
            total.gross_sales += row.gross_sales;
            total.discount_total += row.discount_total;
            total.net_sales += row.net_sales;
            return total;
        },
        {
            product_count: 0,
            order_count: 0,
            qty_sold: 0,
            gross_sales: 0,
            discount_total: 0,
            net_sales: 0,
        }
    );

    return { summary, rows: normalizedRows };
}

// รายงานยอดขายแยกตามหมวดหมู่สินค้า
export async function adminGetSalesByCategoryReport(
    st_id: number,
    filters: { start_date?: string; end_date?: string; lg_code?: string } = {}
): Promise<AdminSalesByCategoryReportDTO> {
    await ensureOrderShipmentTables();

    const params: (number | string)[] = [filters.lg_code ?? "es"];
    const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
    if (storeSql) params.push(st_id);

    const dateSql: string[] = [];
    if (filters.start_date) {
        dateSql.push("DATE(o.update_at) >= ?");
        params.push(filters.start_date);
    }
    if (filters.end_date) {
        dateSql.push("DATE(o.update_at) <= ?");
        params.push(filters.end_date);
    }

    const [rows] = await pool.query<(RowDataPacket & AdminSalesByCategoryRowDTO)[]>(
        `SELECT
            COALESCE(c.c_id, 0) AS c_id,
            COALESCE(cl.cl_name, 'Sin categoría') AS category_name,
            ctl.ctl_name AS catalog_name,
            COUNT(DISTINCT CASE
                WHEN GREATEST(oi.qty - COALESCE(refund_item.refund_qty, 0), 0) > 0
                  OR GREATEST(oi.line_total - COALESCE(refund_item.refund_amount, 0), 0) > 0
                THEN o.or_id
                ELSE NULL
            END) AS order_count,
            COUNT(DISTINCT CASE
                WHEN GREATEST(oi.qty - COALESCE(refund_item.refund_qty, 0), 0) > 0
                  OR GREATEST(oi.line_total - COALESCE(refund_item.refund_amount, 0), 0) > 0
                THEN oi.p_id
                ELSE NULL
            END) AS product_count,
            SUM(GREATEST(oi.qty - COALESCE(refund_item.refund_qty, 0), 0)) AS qty_sold,
            SUM(oi.unit_price * GREATEST(oi.qty - COALESCE(refund_item.refund_qty, 0), 0)) AS gross_sales,
            SUM(oi.discount_amount * GREATEST(oi.qty - COALESCE(refund_item.refund_qty, 0), 0)) AS discount_total,
            SUM(GREATEST(oi.line_total - COALESCE(refund_item.refund_amount, 0), 0)) AS net_sales,
            CASE
                WHEN SUM(GREATEST(oi.qty - COALESCE(refund_item.refund_qty, 0), 0)) > 0
                THEN SUM(GREATEST(oi.line_total - COALESCE(refund_item.refund_amount, 0), 0)) / SUM(GREATEST(oi.qty - COALESCE(refund_item.refund_qty, 0), 0))
                ELSE 0
            END AS average_unit_price
        FROM Order_items oi
        INNER JOIN Orders o ON o.or_id = oi.or_id
        INNER JOIN Status os ON os.s_id = o.s_id
        LEFT JOIN Products p ON p.p_id = oi.p_id
        LEFT JOIN Categorys c ON c.c_id = p.c_id
        LEFT JOIN CategoryLangs cl ON cl.c_id = c.c_id AND cl.lg_code = ?
        LEFT JOIN Catalog ctl ON ctl.ctl_id = c.ctl_id
        LEFT JOIN (
            SELECT
                ri.oi_id,
                SUM(ri.qty) AS refund_qty,
                SUM(ri.amount) AS refund_amount
            FROM Refund_items ri
            INNER JOIN Refunds r ON r.refund_id = ri.refund_id
            WHERE r.status = 'succeeded'
            GROUP BY ri.oi_id
        ) refund_item ON refund_item.oi_id = oi.oi_id
        LEFT JOIN (
            SELECT
                or_id,
                MAX(occurred_at) AS delivered_at
            FROM Order_shipment_events
            WHERE status = 'POD'
               OR LOWER(COALESCE(description, '')) LIKE '%delivery successfully%'
            GROUP BY or_id
        ) delivered_event ON delivered_event.or_id = o.or_id
        WHERE os.s_code IN ('RECEIVED', 'AUTO_RECEIVED', 'REVIEWED')
            ${storeSql}
            ${dateSql.length ? `AND ${dateSql.join(" AND ")}` : ""}
        GROUP BY c_id, category_name, catalog_name
        HAVING qty_sold > 0 OR net_sales > 0
        ORDER BY net_sales DESC, qty_sold DESC`,
        params
    );

    // รายงานตามหมวดใช้ยอดขายสุทธิเท่านั้น เพราะระบบไม่เก็บต้นทุนสินค้าเพื่อคำนวณกำไร
    const normalizedRows = rows.map((row) => ({
        ...row,
        c_id: Number(row.c_id ?? 0),
        order_count: Number(row.order_count ?? 0),
        product_count: Number(row.product_count ?? 0),
        qty_sold: Number(row.qty_sold ?? 0),
        gross_sales: Number(row.gross_sales ?? 0),
        discount_total: Number(row.discount_total ?? 0),
        net_sales: Number(row.net_sales ?? 0),
        average_unit_price: Number(row.average_unit_price ?? 0),
    }));

    const summary = normalizedRows.reduce(
        (total, row) => {
            total.category_count += 1;
            total.order_count += row.order_count;
            total.product_count += row.product_count;
            total.qty_sold += row.qty_sold;
            total.gross_sales += row.gross_sales;
            total.discount_total += row.discount_total;
            total.net_sales += row.net_sales;
            return total;
        },
        {
            category_count: 0,
            order_count: 0,
            product_count: 0,
            qty_sold: 0,
            gross_sales: 0,
            discount_total: 0,
            net_sales: 0,
        }
    );

    return { summary, rows: normalizedRows };
}

// รายงานยอดขายแยกตามลูกค้า ใช้ดู buyer ที่ซื้อเยอะหรือซื้อบ่อย
export async function adminGetSalesByBuyerReport(
    st_id: number,
    filters: { start_date?: string; end_date?: string } = {}
): Promise<AdminSalesByBuyerReportDTO> {
    await ensureOrderShipmentTables();

    const params: (number | string)[] = [];
    const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
    if (storeSql) params.push(st_id);

    const dateSql: string[] = [];
    if (filters.start_date) {
        dateSql.push("DATE(o.update_at) >= ?");
        params.push(filters.start_date);
    }
    if (filters.end_date) {
        dateSql.push("DATE(o.update_at) <= ?");
        params.push(filters.end_date);
    }

    const [rows] = await pool.query<(RowDataPacket & AdminSalesByBuyerRowDTO)[]>(
        `SELECT
            o.u_id,
            COALESCE(NULLIF(u.u_username, ''), o.shipping_name, CONCAT('Customer #', o.u_id)) AS customer_name,
            o.st_id,
            st.st_company_name,
            COUNT(DISTINCT o.or_id) AS order_count,
            SUM(COALESCE(item_summary.item_count, 0)) AS item_count,
            SUM(COALESCE(item_summary.item_gross_total, o.subtotal) + COALESCE(o.shipping_fee, 0)) AS gross_sales,
            SUM(COALESCE(o.discount_total, 0) + COALESCE(item_summary.item_discount_total, 0)) AS discount_total,
            SUM(COALESCE(refund.refund_total, 0)) AS refund_total,
            SUM(GREATEST(o.grand_total - COALESCE(refund.refund_total, 0), 0)) AS net_sales,
            CASE
                WHEN COUNT(DISTINCT o.or_id) > 0
                THEN SUM(GREATEST(o.grand_total - COALESCE(refund.refund_total, 0), 0)) / COUNT(DISTINCT o.or_id)
                ELSE 0
            END AS average_order_value,
            MAX(o.update_at) AS latest_sale_date
        FROM Orders o
        LEFT JOIN Users u ON u.u_id = o.u_id
        LEFT JOIN Store st ON st.st_id = o.st_id
        LEFT JOIN Status os ON os.s_id = o.s_id
        LEFT JOIN (
            SELECT
                or_id,
                COUNT(oi_id) AS item_count,
                SUM(unit_price * qty) AS item_gross_total,
                SUM(discount_amount * qty) AS item_discount_total
            FROM Order_items
            GROUP BY or_id
        ) item_summary ON item_summary.or_id = o.or_id
        LEFT JOIN (
            SELECT
                po.or_id,
                MAX(p.paid_at) AS paid_at
            FROM Payment_orders po
            INNER JOIN Payments p ON p.pay_id = po.pay_id
            WHERE p.payment_status = 'paid'
            GROUP BY po.or_id
        ) pay ON pay.or_id = o.or_id
        LEFT JOIN (
            SELECT
                or_id,
                MAX(occurred_at) AS delivered_at
            FROM Order_shipment_events
            WHERE status = 'POD'
               OR LOWER(COALESCE(description, '')) LIKE '%delivery successfully%'
            GROUP BY or_id
        ) delivered_event ON delivered_event.or_id = o.or_id
        LEFT JOIN (
            SELECT or_id, SUM(amount) AS refund_total
            FROM Refunds
            WHERE status = 'succeeded'
            GROUP BY or_id
        ) refund ON refund.or_id = o.or_id
        WHERE os.s_code IN ('RECEIVED', 'AUTO_RECEIVED', 'REVIEWED')
            ${storeSql}
            ${dateSql.length ? `AND ${dateSql.join(" AND ")}` : ""}
        GROUP BY o.u_id, customer_name, o.st_id, st.st_company_name
        ORDER BY net_sales DESC, latest_sale_date DESC`,
        params
    );

    // Normalize MySQL aggregate values before calculating summary so the API always returns numbers.
    const normalizedRows = rows.map((row) => ({
        ...row,
        u_id: Number(row.u_id ?? 0),
        st_id: Number(row.st_id ?? 0),
        order_count: Number(row.order_count ?? 0),
        item_count: Number(row.item_count ?? 0),
        gross_sales: Number(row.gross_sales ?? 0),
        discount_total: Number(row.discount_total ?? 0),
        refund_total: Number(row.refund_total ?? 0),
        net_sales: Number(row.net_sales ?? 0),
        average_order_value: Number(row.average_order_value ?? 0),
    }));

    const storeIds = new Set<number>();
    const summary = normalizedRows.reduce(
        (total, row) => {
            storeIds.add(row.st_id);
            total.buyer_count += 1;
            total.order_count += row.order_count;
            total.item_count += row.item_count;
            total.gross_sales += row.gross_sales;
            total.discount_total += row.discount_total;
            total.refund_total += row.refund_total;
            total.net_sales += row.net_sales;
            if (row.order_count > 1) total.repeat_buyer_count += 1;
            return total;
        },
        {
            buyer_count: 0,
            store_count: 0,
            order_count: 0,
            item_count: 0,
            gross_sales: 0,
            discount_total: 0,
            refund_total: 0,
            net_sales: 0,
            average_per_buyer: 0,
            repeat_buyer_count: 0,
            repeat_buyer_rate: 0,
        }
    );

    summary.store_count = storeIds.size;
    summary.average_per_buyer = summary.buyer_count > 0 ? summary.net_sales / summary.buyer_count : 0;
    summary.repeat_buyer_rate = summary.buyer_count > 0 ? (summary.repeat_buyer_count / summary.buyer_count) * 100 : 0;

    return { summary, rows: normalizedRows };
}

// ดึงรายละเอียด order ฝั่งร้าน รวม items, shipment และรูปหลักฐานคืนเงิน
export async function adminGetOrderById(or_id: number, st_id: number, lg_code = "es"): Promise<AdminOrderDetailDTO | null> {
    await ensureOrderShipmentLabelColumn();
    await ensureOrderShipmentTables();
    await ensureRefundMethodColumn();

    const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];
    const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";

    const [orderRows] = await pool.query<(RowDataPacket & AdminOrderDTO)[]>(
        `SELECT
            o.or_id, o.order_no, o.u_id, o.cart_id, o.co_id, o.st_id, o.s_id,
            s.st_company_name,
            s.is_platform_store AS st_is_platform_store,
            COALESCE(NULLIF(u.u_username, ''), o.shipping_name, CONCAT('Customer #', o.u_id)) AS customer_name,
            o.status, os.s_code AS status_code, osl.s_name AS status_label,
            latest_refund.refund_id AS refund_id,
            latest_refund.amount AS refund_amount,
            latest_refund.remark AS refund_remark,
            latest_refund.return_tracking AS return_tracking,
            latest_refund.updated_at AS refund_updated_at,
            latest_refund.status AS refund_status,
            latest_refund.refund_method AS refund_method,
            o.subtotal, o.discount_total, o.shipping_fee,
            o.provider_shipping_cost,
            o.shipping_sc_id,
            sc.sc_code AS shipping_carrier_code,
            sc.sc_name AS shipping_carrier_name,
            o.tracking_no,
            o.tracking_url,
            o.label_url,
            sc.tracking_url_template,
            o.shipment_status,
            o.grand_total, o.coupon_code,
            o.shipping_name, o.shipping_phone, o.shipping_address,
            lb.zip_code AS shipping_zip_code,
            lb.country_code AS shipping_country_code,
            lb.state AS shipping_state,
            lb.city AS shipping_city,
            lb.municipality AS shipping_municipality,
            lb.colonia AS shipping_colonia,
            lb.state AS shipping_province_name,
            COALESCE(lb.municipality, lb.city) AS shipping_district_name,
            lb.colonia AS shipping_subdistrict_name,
            o.remark, o.payment_expires_at, o.created_at, o.update_at,
            COUNT(oi.oi_id) AS item_count
        FROM Orders o
        LEFT JOIN Store s ON s.st_id = o.st_id
        LEFT JOIN Shipping_carriers sc ON sc.sc_id = o.shipping_sc_id
        LEFT JOIN Status os ON os.s_id = o.s_id
        LEFT JOIN StatusLangs osl ON osl.s_id = os.s_id AND osl.lg_code = ?
        LEFT JOIN (
            SELECT r1.or_id, r1.refund_id, r1.amount, r1.status, r1.remark, r1.return_tracking, r1.updated_at, r1.refund_method
            FROM Refunds r1
            INNER JOIN (
                SELECT or_id, MAX(refund_id) AS refund_id
                FROM Refunds
                GROUP BY or_id
            ) latest ON latest.refund_id = r1.refund_id
        ) latest_refund ON latest_refund.or_id = o.or_id
        LEFT JOIN Users u ON u.u_id = o.u_id
        LEFT JOIN Locations_buyer lb
            ON lb.u_id = o.u_id
           AND lb.locb_recipient_name = o.shipping_name
           AND lb.locb_phone = o.shipping_phone
           AND lb.locb_address = o.shipping_address        LEFT JOIN Order_items oi ON oi.or_id = o.or_id
        WHERE o.or_id = ?
        ${storeSql}
        GROUP BY o.or_id
        LIMIT 1`,
        [lg_code, ...params]
    );

    const order = orderRows[0];
    if (!order) return null;

    const [itemRows] = await pool.query<(RowDataPacket & OrderItemDTO)[]>(
        `${orderItemsSelectSql} WHERE oi.or_id = ? ORDER BY oi.oi_id ASC`,
        [lg_code, or_id]
    );

    const syncedStatuses = await syncShipmentEventsFromProvider([or_id]);
    const syncedStatus = syncedStatuses.get(or_id);
    const syncedStatusLabel = syncedStatus === "delivered" ? await getStatusLangName("DELIVERED", lg_code) : null;
    const shouldApplyDeliveredSync = syncedStatus === "delivered" && !ORDER_RECEIVED_STATUS_CODES.includes(order.status_code as OrderStatusCode);
    const [shipmentMap, eventMap, annotatedItems, refundItems, refundHistory] = await Promise.all([
        getOrderShipments([or_id]),
        getShipmentEvents([or_id]),
        annotateRefundedQty(itemRows, or_id),
        getLatestRefundItems(order.refund_id),
        getRefundHistory(or_id),
    ]);

    let refundImages: string[] = [];
    if (order.refund_id) {
        const [imgRows] = await pool.query<(RowDataPacket & { url_image: string })[]>(
            "SELECT url_image FROM Refund_images WHERE refund_id = ? ORDER BY rfi_id ASC",
            [order.refund_id]
        );
        refundImages = imgRows.map(r => r.url_image);
    }

    return {
        ...order,
        status: shouldApplyDeliveredSync ? "delivered" : order.status,
        status_code: (shouldApplyDeliveredSync ? "DELIVERED" : order.status_code ?? null) as string | null,
        status_label: (shouldApplyDeliveredSync ? syncedStatusLabel : order.status_label ?? null) as string | null,
        shipment_status: (syncedStatus ?? order.shipment_status ?? null) as string | null,
        items: annotatedItems,
        shipments: shipmentMap.get(or_id) ?? [],
        shipment_events: eventMap.get(or_id) ?? [],
        refund_images: refundImages,
        refund_items: refundItems,
        refund_history: refundHistory,
    };
}

// ดึงรายละเอียด order ของ buyer รายเดียว พร้อม items และ shipment timeline
export async function getOrderById(or_id: number, u_id: number, lg_code = "es"): Promise<OrderDetailDTO | null> {
    await ensureOrderShipmentLabelColumn();
    await ensureOrderShipmentTables();

    const [orderRows] = await pool.query<(RowDataPacket & OrderDTO)[]>(
        `${orderSelectSql} WHERE o.or_id = ? AND o.u_id = ? LIMIT 1`,
        [lg_code, or_id, u_id]
    );

    if (!orderRows[0]) return null;

    const [itemRows] = await pool.query<(RowDataPacket & OrderItemDTO)[]>(
        `${orderItemsSelectSql} WHERE oi.or_id = ? ORDER BY oi.oi_id ASC`,
        [lg_code, or_id]
    );

    const syncedStatuses = await syncShipmentEventsFromProvider([or_id]);
    const syncedStatus = syncedStatuses.get(or_id);
    const syncedStatusLabel = syncedStatus === "delivered" ? await getStatusLangName("DELIVERED", lg_code) : null;
    const shouldApplyDeliveredSync = syncedStatus === "delivered" && !ORDER_RECEIVED_STATUS_CODES.includes(orderRows[0].status_code as OrderStatusCode);
    const [shipmentMap, eventMap, annotatedItems, refundItems] = await Promise.all([
        getOrderShipments([or_id]),
        getShipmentEvents([or_id]),
        annotateRefundedQty(itemRows, or_id),
        getLatestRefundItems(orderRows[0].refund_id),
    ]);
    return {
        ...orderRows[0],
        status: shouldApplyDeliveredSync ? "delivered" : orderRows[0].status,
        status_code: (shouldApplyDeliveredSync ? "DELIVERED" : orderRows[0].status_code ?? null) as string | null,
        status_label: (shouldApplyDeliveredSync ? syncedStatusLabel : orderRows[0].status_label ?? null) as string | null,
        shipment_status: (syncedStatus ?? orderRows[0].shipment_status ?? null) as string | null,
        items: annotatedItems,
        shipments: shipmentMap.get(or_id) ?? [],
        shipment_events: eventMap.get(or_id) ?? [],
        refund_items: refundItems,
    };
}

// buyer ยืนยันรับสินค้าเอง เปลี่ยนสถานะจาก DELIVERED เป็น RECEIVED
export async function confirmOrderReceived(or_id: number, u_id: number, lg_code = "es"): Promise<OrderDetailDTO> {
    await ensureOrderShipmentLabelColumn();

    const conn = await pool.getConnection();
    let committed = false;
    try {
        await conn.beginTransaction();

        const [orderRows] = await conn.query<(RowDataPacket & OrderDTO)[]>(
            `${orderSelectSql} WHERE o.or_id = ? AND o.u_id = ? LIMIT 1 FOR UPDATE`,
            [lg_code, or_id, u_id]
        );

        const order = orderRows[0];
        if (!order) throw new ApiError(404, "No se encontró el pedido.");
        if (ORDER_RECEIVED_STATUS_CODES.includes(order.status_code as OrderStatusCode)) {
            await conn.commit();
            committed = true;
            const currentOrder = await getOrderById(or_id, u_id, lg_code);
            if (!currentOrder) throw new ApiError(404, "No se encontró el pedido.");
            return currentOrder;
        }
        // ยืนยันรับสินค้าได้แม้มีคำขอคืนสินค้าบางรายการค้าง (pending) อยู่ก็ตาม — แยกเรื่อง "ได้รับพัสดุแล้ว" ออกจากเรื่อง "กำลังคืนบางชิ้น" โดยสิ้นเชิง
        // ไม่งั้นรายการที่ไม่เกี่ยวกับการคืนจะกดยืนยันรับสินค้าไม่ได้เลยจนกว่า admin จะเคลียร์คำขอคืนให้เสร็จ
        if (order.status_code !== "DELIVERED" && order.status_code !== "RETURN_REQUESTED") {
            throw new ApiError(400, "Este pedido aún no se puede confirmar como recibido.");
        }

        await setOrdersStatus(conn, [or_id], "RECEIVED", {
            remark: "Buyer confirmed received",
            whereUserId: u_id,
        });

        await conn.commit();
        committed = true;

        const receivedOrder = await getOrderById(or_id, u_id, lg_code);
        if (!receivedOrder) throw new ApiError(404, "No se encontró el pedido.");

        await notifyOrderEvent({
            event: "order:received",
            order: receivedOrder,
            actor: "buyer",
            targets: ["STORE"],
            title: "El cliente confirmó la recepción",
            message: `El cliente confirmó la recepción del pedido ${receivedOrder.order_no}.`,
            priority: "HIGH",
        });

        return receivedOrder;
    } catch (err) {
        if (!committed) await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// buyer ยกเลิก order ที่ยังรอชำระ พร้อมคืน stock reserve และคืน usage คูปอง
export async function cancelOrder(or_id: number, u_id: number, reason: string, lg_code = "es"): Promise<OrderDetailDTO> {
    await ensureInventoryReservationTable();
    await ensureOrderShipmentLabelColumn();

    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const [orderRows] = await conn.query<(RowDataPacket & OrderDTO)[]>(
            `${orderSelectSql} WHERE o.or_id = ? AND o.u_id = ? LIMIT 1 FOR UPDATE`,
            [lg_code, or_id, u_id]
        );

        const order = orderRows[0];
        if (!order) throw new ApiError(404, "No se encontró el pedido.");
        if (!BUYER_CANCELLABLE_STATUS_CODES.includes(order.status_code as OrderStatusCode)) {
            throw new ApiError(400, "Este pedido ya no se puede cancelar.");
        }

        await setOrdersStatus(conn, [or_id], "CANCELLED", {
            remark: `Cancel reason: ${reason}`,
            whereUserId: u_id,
        });

        // ยกเลิก order pending แล้วต้องปล่อย stock ที่เคยกันไว้กลับเป็น available_qty
        await releaseReservationsForOrders(conn, [or_id]);
        await restoreCouponUsageForCancelledOrder(conn, order);
        await conn.commit();

        const cancelledOrder = await getOrderById(or_id, u_id, lg_code);
        if (!cancelledOrder) throw new ApiError(404, "No se encontró el pedido.");

        await notifyOrderEvent({
            event: "order:cancelled",
            order: cancelledOrder,
            actor: "buyer",
            targets: ["STORE"],
            title: "El cliente canceló el pedido",
            message: `El pedido ${cancelledOrder.order_no} fue cancelado. Motivo: ${reason}`,
            priority: "HIGH",
        });

        return cancelledOrder;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// จำนวนต่อ oi_id ที่มีคำขอคืนคุ้มครองอยู่แล้ว (pending หรือ succeeded) ของ order นี้ ใช้คำนวณจำนวนที่เหลือคืนได้ (item.qty - protected)
async function getProtectedRefundQtyMap(conn: PoolConnection, or_id: number): Promise<Map<number, number>> {
    const [rows] = await conn.query<(RowDataPacket & { oi_id: number; qty: number })[]>(
        `SELECT ri.oi_id, SUM(ri.qty) AS qty
         FROM Refund_items ri
         INNER JOIN Refunds r ON r.refund_id = ri.refund_id
         WHERE r.or_id = ? AND r.status IN ('pending', 'succeeded')
         GROUP BY ri.oi_id`,
        [or_id]
    );
    return new Map(rows.map((row) => [Number(row.oi_id), Number(row.qty)]));
}

// เช็คว่าทุกรายการ (ทุกจำนวน) สินค้าในออเดอร์นี้ถูกคืนสำเร็จ (succeeded) ครบแล้วหรือยัง — ใช้ตัดสินว่าจะปิดสถานะออเดอร์แบบ terminal หรือคืนกลับ DELIVERED
async function allOrderItemsReturned(conn: PoolConnection, or_id: number): Promise<boolean> {
    const [rows] = await conn.query<(RowDataPacket & { remaining: number })[]>(
        `SELECT COALESCE(SUM(GREATEST(oi.qty - COALESCE(returned.qty, 0), 0)), 0) AS remaining
         FROM Order_items oi
         LEFT JOIN (
             SELECT ri.oi_id, SUM(ri.qty) AS qty
             FROM Refund_items ri
             INNER JOIN Refunds r ON r.refund_id = ri.refund_id
             WHERE r.or_id = ? AND r.status = 'succeeded'
             GROUP BY ri.oi_id
         ) returned ON returned.oi_id = oi.oi_id
         WHERE oi.or_id = ?`,
        [or_id, or_id]
    );
    return Number(rows[0]?.remaining ?? 0) === 0;
}

// ผูก refunded_qty (จำนวนที่มีคำขอคืน pending/succeeded คุ้มครองอยู่) เข้ากับแต่ละ item เพื่อให้ buyer/admin เห็นว่ารายการไหนคืนไปแล้ว
async function annotateRefundedQty(items: OrderItemDTO[], or_id: number): Promise<OrderItemDTO[]> {
    if (items.length === 0) return items;
    const [rows] = await pool.query<(RowDataPacket & { oi_id: number; refunded_qty: number })[]>(
        `SELECT ri.oi_id, SUM(ri.qty) AS refunded_qty
         FROM Refund_items ri
         INNER JOIN Refunds r ON r.refund_id = ri.refund_id
         WHERE r.or_id = ? AND r.status IN ('pending', 'succeeded')
         GROUP BY ri.oi_id`,
        [or_id]
    );
    const refundedMap = new Map(rows.map((row) => [Number(row.oi_id), Number(row.refunded_qty)]));
    return items.map((item) => ({ ...item, refunded_qty: refundedMap.get(item.oi_id) ?? 0 }));
}

// รายการสินค้าที่คำขอคืน (refund_id) ล่าสุดของออเดอร์ครอบคลุมอยู่ ใช้แสดงในหน้า admin/buyer ว่าคำขอปัจจุบันคืนรายการไหนบ้าง
async function getLatestRefundItems(refund_id: number | null | undefined): Promise<RefundItemDTO[]> {
    if (!refund_id) return [];
    const [rows] = await pool.query<(RowDataPacket & { oi_id: number; qty: number; amount: number; product_name: string; variant_name: string | null })[]>(
        `SELECT ri.oi_id, ri.qty, ri.amount, oi.product_name, oi.variant_name
         FROM Refund_items ri
         INNER JOIN Order_items oi ON oi.oi_id = ri.oi_id
         WHERE ri.refund_id = ?
         ORDER BY ri.oi_id ASC`,
        [refund_id]
    );
    return rows.map((row) => ({
        oi_id: Number(row.oi_id),
        qty: Number(row.qty),
        amount: Number(row.amount),
        product_name: row.product_name,
        variant_name: row.variant_name,
    }));
}

// ประวัติคำขอคืนเงินทุกรอบของออเดอร์ (ไม่ใช่แค่รอบล่าสุด) พร้อมรายการสินค้าที่คืนในแต่ละรอบ ใช้แสดงในหน้า admin
async function getRefundHistory(or_id: number): Promise<RefundHistoryEntryDTO[]> {
    const [refundRows] = await pool.query<(RowDataPacket & {
        refund_id: number;
        status: "pending" | "succeeded" | "failed";
        amount: number;
        remark: string | null;
        return_tracking: string | null;
        refund_method: "mercado_pago" | "omise" | "manual" | null;
        created_at: string;
        updated_at: string;
    })[]>(
        `SELECT refund_id, status, amount, remark, return_tracking, refund_method, created_at, updated_at
         FROM Refunds
         WHERE or_id = ?
         ORDER BY refund_id DESC`,
        [or_id]
    );
    if (refundRows.length === 0) return [];

    const refundIds = refundRows.map((row) => Number(row.refund_id));
    const [itemRows] = await pool.query<(RowDataPacket & { refund_id: number; oi_id: number; qty: number; amount: number; product_name: string; variant_name: string | null })[]>(
        `SELECT ri.refund_id, ri.oi_id, ri.qty, ri.amount, oi.product_name, oi.variant_name
         FROM Refund_items ri
         INNER JOIN Order_items oi ON oi.oi_id = ri.oi_id
         WHERE ri.refund_id IN (?)
         ORDER BY ri.oi_id ASC`,
        [refundIds]
    );
    const itemsByRefundId = new Map<number, RefundItemDTO[]>();
    for (const row of itemRows) {
        const refundId = Number(row.refund_id);
        const list = itemsByRefundId.get(refundId) ?? [];
        list.push({
            oi_id: Number(row.oi_id),
            qty: Number(row.qty),
            amount: Number(row.amount),
            product_name: row.product_name,
            variant_name: row.variant_name,
        });
        itemsByRefundId.set(refundId, list);
    }

    const [imageRows] = await pool.query<(RowDataPacket & { refund_id: number; url_image: string })[]>(
        `SELECT refund_id, url_image
         FROM Refund_images
         WHERE refund_id IN (?)
         ORDER BY rfi_id ASC`,
        [refundIds]
    );
    const imagesByRefundId = new Map<number, string[]>();
    for (const row of imageRows) {
        const refundId = Number(row.refund_id);
        const list = imagesByRefundId.get(refundId) ?? [];
        list.push(row.url_image);
        imagesByRefundId.set(refundId, list);
    }

    return refundRows.map((row) => ({
        refund_id: Number(row.refund_id),
        status: row.status,
        amount: Number(row.amount),
        remark: row.remark,
        return_tracking: row.return_tracking,
        refund_method: row.refund_method,
        created_at: row.created_at,
        updated_at: row.updated_at,
        items: itemsByRefundId.get(Number(row.refund_id)) ?? [],
        images: imagesByRefundId.get(Number(row.refund_id)) ?? [],
    }));
}

export type RefundItemSelection = { oi_id: number; qty: number };

// buyer ส่งคำขอคืนเงิน/คืนสินค้า พร้อมเหตุผล tracking คืน และรูปหลักฐาน
// selectedItems: รายการ {oi_id, qty} ที่ต้องการคืน (เฉพาะตอนสถานะ DELIVERED เท่านั้นที่เลือกได้บางรายการ/บางจำนวน — สถานะอื่นถือเป็นการยกเลิกทั้งออเดอร์เหมือนเดิม)
export async function requestRefund(or_id: number, u_id: number, reason: string, lg_code = "es", returnTracking = "", imageFiles: Express.Multer.File[] = [], selectedItems: RefundItemSelection[] = []): Promise<OrderDetailDTO> {
    await ensureRefundImagesTable();
    await ensureRefundReturnTrackingColumn();
    await ensureOrderShipmentLabelColumn();

    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const [orderRows] = await conn.query<(RowDataPacket & OrderDTO)[]>(
            `${orderSelectSql} WHERE o.or_id = ? AND o.u_id = ? LIMIT 1 FOR UPDATE`,
            [lg_code, or_id, u_id]
        );

        const order = orderRows[0];
        if (!order) throw new ApiError(404, "No se encontró el pedido.");
        const statusCode = order.status_code as OrderStatusCode;
        if (!REFUND_REQUESTABLE_STATUS_CODES.includes(statusCode)) {
            throw new ApiError(400, "Este pedido aún no puede solicitar un reembolso.");
        }
        if (statusCode === "DELIVERED" && imageFiles.length === 0) {
            throw new ApiError(400, "Adjunta al menos 1 foto del producto que deseas devolver.");
        }

        // buyer ทำได้แค่สร้าง request pending เท่านั้น
        // การคืนเงินจริงต้องดำเนินการฝั่งร้าน/admin หลังตรวจสอบคำขอแล้ว
        // คำขอที่ยัง pending ต้องได้รับการอนุมัติ/ปฏิเสธก่อน ถึงจะยื่นคำขอใหม่ได้ (รายการที่คืนสำเร็จไปแล้วไม่บล็อกรายการอื่นที่เหลือ)
        const [existingRefunds] = await conn.query<(RowDataPacket & { refund_id: number; status: string })[]>(
            "SELECT refund_id, status FROM Refunds WHERE or_id = ? AND status = 'pending' ORDER BY refund_id DESC LIMIT 1 FOR UPDATE",
            [or_id]
        );
        if (existingRefunds[0]) {
            throw new ApiError(409, "Este pedido ya tiene una solicitud de reembolso en curso.");
        }

        const [itemRows] = await conn.query<(RowDataPacket & OrderItemDTO)[]>(
            `${orderItemsSelectSql} WHERE oi.or_id = ? ORDER BY oi.oi_id ASC`,
            [lg_code, or_id]
        );
        if (itemRows.length === 0) throw new ApiError(404, "No se encontraron productos en este pedido.");

        const itemsByOiId = new Map(itemRows.map((item) => [item.oi_id, item]));
        const protectedQtyMap = statusCode === "DELIVERED" ? await getProtectedRefundQtyMap(conn, or_id) : new Map<number, number>();
        // includedItems: รายการที่จะบันทึกลง Refund_items จริง พร้อมจำนวนที่คืน (qty) และยอดเงินตามสัดส่วน (amount)
        let includedItems: { oi_id: number; qty: number; amount: number }[] = itemRows.map((item) => ({
            oi_id: item.oi_id,
            qty: item.qty,
            amount: Number(item.line_total),
        }));

        if (statusCode === "DELIVERED") {
            if (selectedItems.length === 0) {
                throw new ApiError(400, "Selecciona los productos que deseas devolver.");
            }

            // รวมจำนวนต่อ oi_id กรณี frontend ส่งรายการเดียวกันมาซ้ำ
            const qtyByOiId = new Map<number, number>();
            for (const sel of selectedItems) {
                const oiId = Number(sel.oi_id);
                const qty = Number(sel.qty);
                if (!Number.isInteger(qty) || qty <= 0) {
                    throw new ApiError(400, "La cantidad seleccionada para devolver no es válida.");
                }
                qtyByOiId.set(oiId, (qtyByOiId.get(oiId) ?? 0) + qty);
            }

            includedItems = [...qtyByOiId.entries()].map(([oiId, qty]) => {
                const item = itemsByOiId.get(oiId);
                if (!item) throw new ApiError(400, "El producto seleccionado no es válido.");

                const alreadyProtected = protectedQtyMap.get(oiId) ?? 0;
                const remaining = item.qty - alreadyProtected;
                if (qty > remaining) {
                    throw new ApiError(409, "La cantidad seleccionada supera la disponible para devolución (es posible que ya se haya devuelto una parte).");
                }

                return {
                    oi_id: oiId,
                    qty,
                    amount: (Number(item.line_total) / item.qty) * qty,
                };
            });
        }

        const isFullReturn = includedItems.length === itemRows.length
            && includedItems.every((sel) => sel.qty === itemsByOiId.get(sel.oi_id)!.qty)
            && protectedQtyMap.size === 0;
        const refundAmount = isFullReturn
            ? Number(order.grand_total)
            : includedItems.reduce((sum, item) => sum + item.amount, 0);

        const [paymentRows] = await conn.query<(RowDataPacket & { payment_ref: string | null })[]>(
            `SELECT p.payment_ref
             FROM Payments p
             INNER JOIN Payment_orders po ON po.pay_id = p.pay_id
             WHERE po.or_id = ?
               AND p.payment_status = 'paid'
             ORDER BY p.pay_id DESC
             LIMIT 1`,
            [or_id]
        );
        const paymentRef = paymentRows[0]?.payment_ref ?? null;
        if (!paymentRef) {
            throw new ApiError(400, "No se encontró la referencia de pago para procesar el reembolso.");
        }

        const [refundRes] = await conn.query<ResultSetHeader>(
            `INSERT INTO Refunds
                (or_id, payment_ref, amount, status, remark, return_tracking, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
            [or_id, paymentRef, refundAmount.toFixed(2), reason, returnTracking || null, new Date(), new Date()]
        );

        if (includedItems.length > 0) {
            const refundItems = includedItems.map((item) => [
                refundRes.insertId,
                item.oi_id,
                item.qty,
                item.amount.toFixed(2),
                new Date(),
            ]);

            await conn.query(
                "INSERT INTO Refund_items (refund_id, oi_id, qty, amount, created_at) VALUES ?",
                [refundItems]
            );
        }

        if (statusCode === "DELIVERED") {
            await setOrdersStatus(conn, [or_id], "RETURN_REQUESTED", { remark: reason });
        }

        await conn.commit();

        // อัปโหลดรูปหลัง commit เพื่อไม่ให้ rollback ติด network error
        const refundImageUrls: string[] = [];
        if (imageFiles.length > 0) {
            const refundId = refundRes.insertId;
            await Promise.all(
                imageFiles.map(async (file, i) => {
                    const url = await fileUploadImage(file, `refund_${refundId}_${i}`, "refunds");
                    refundImageUrls.push(url);
                    await pool.query(
                        "INSERT INTO Refund_images (refund_id, url_image, created_at) VALUES (?, ?, ?)",
                        [refundId, url, new Date()]
                    );
                })
            );
        }

        const updatedOrder = await getOrderById(or_id, u_id, lg_code);
        if (!updatedOrder) throw new ApiError(404, "No se encontró el pedido.");

        await notifyOrderEvent({
            event: "order:refund_requested",
            order: updatedOrder,
            actor: "buyer",
            targets: ["STORE"],
            title: "Nueva solicitud de devolución o reembolso",
            message: `El cliente solicitó la devolución del pedido ${updatedOrder.order_no}. Motivo: ${reason}`,
            priority: "URGENT",
        });

        try {
            await chatService.postRefundContextToConversation({
                userId: u_id,
                storeId: Number(updatedOrder.st_id),
                orderNo: updatedOrder.order_no ?? `ORDER-${or_id}`,
                reason,
                amount: Number(updatedOrder.grand_total),
                returnTracking,
                imageUrls: refundImageUrls,
            });
        } catch (error) {
            console.warn(`[orders] post refund context to chat failed for order ${or_id}:`, error);
        }

        return updatedOrder;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// admin อนุมัติคำขอคืนเงินและพยายาม refund ผ่าน Mercado Pago อัตโนมัติ
export async function approveRefundRequest(or_id: number, st_id: number, note = "", lg_code = "es"): Promise<AdminOrderDetailDTO> {
    await ensureInventoryReservationTable();
    await ensureRefundMethodColumn();

    const conn = await pool.getConnection();
    let committed = false;

    try {
        await conn.beginTransaction();

        const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
        const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

        const [rows] = await conn.query<(RowDataPacket & {
            or_id: number;
            order_no: string;
            status_code: string | null;
            payment_ref: string | null;
            refund_id: number;
            amount: number;
            refund_status: string;
        })[]>(
            `SELECT o.or_id, o.order_no, os.s_code AS status_code, p.payment_ref, r.refund_id, r.amount, r.status AS refund_status
             FROM Orders o
             LEFT JOIN Status os ON os.s_id = o.s_id
             INNER JOIN Refunds r ON r.or_id = o.or_id
             INNER JOIN Payment_orders po ON po.or_id = o.or_id
             INNER JOIN Payments p ON p.pay_id = po.pay_id
             WHERE o.or_id = ?
               ${storeSql}
               AND r.status = 'pending'
               AND p.payment_status = 'paid'
             ORDER BY r.refund_id DESC, p.pay_id DESC
             LIMIT 1
             FOR UPDATE`,
            params
        );

        const refund = rows[0];
        if (!refund) throw new ApiError(404, "No se encontró una solicitud de reembolso pendiente.");
        // ถ้า order อยู่ RETURN_REQUESTED หรือ buyer ยืนยันรับสินค้า (RECEIVED-tier) ไปแล้วระหว่างที่คำขอนี้ยัง pending
        // แสดงว่าเป็นคำขอคืนสินค้าที่ต้องรอตรวจสอบพัสดุที่ส่งคืนก่อน ต้องใช้ endpoint confirmReturnReceived แทน ไม่ใช่ endpoint นี้
        if (refund.status_code === "RETURN_REQUESTED" || ORDER_RECEIVED_STATUS_CODES.includes(refund.status_code as OrderStatusCode)) {
            throw new ApiError(400, "Esta solicitud es de devolución de producto. Confirma la recepción del producto devuelto antes de procesar el reembolso.");
        }
        if (!refund.payment_ref) throw new ApiError(400, "No se encontró la referencia de pago para procesar el reembolso.");

        try {
            await createMercadoPagoRefund({
                paymentId: refund.payment_ref,
                amount: Number(refund.amount),
                metadata: {
                    order_id: String(refund.or_id),
                    order_no: refund.order_no,
                    refund_id: String(refund.refund_id),
                },
            });
        } catch (err) {
            const details = err instanceof ApiError ? err.details as { code?: string; message?: string } : null;
            const providerMessage = details?.message || (err instanceof Error ? err.message : "No se pudo procesar el reembolso a través de Mercado Pago.");
            const failureRemark = [
                note.trim(),
                `El reembolso a través de Mercado Pago no se completó: ${providerMessage}`,
                "Debe transferirse manualmente al cliente porque Mercado Pago rechazó o no admite el reembolso de este pedido.",
            ].filter(Boolean).join(" | ");

            await conn.query(
                "UPDATE Refunds SET status = 'failed', refund_method = 'manual', remark = ?, updated_at = ? WHERE refund_id = ?",
                [failureRemark, new Date(), refund.refund_id]
            );
            await conn.commit();
            committed = true;

            const order = await adminGetOrderById(or_id, st_id, lg_code);
            if (!order) throw new ApiError(404, "No se encontró el pedido.");

            await notifyOrderEvent({
                event: "order:refund_rejected",
                order,
                actor: "admin",
                targets: ["USER"],
                title: "Reembolso en proceso",
                message: `El reembolso del pedido ${order.order_no} debe procesarse manualmente. La tienda se pondrá en contacto para coordinarlo.`,
                priority: "HIGH",
            });
            await notifyPlatformManualRefundNeeded(order);

            return order;
        }

        const remark = [note.trim(), "Reembolso realizado con éxito a través de Mercado Pago."]
            .filter(Boolean)
            .join(" | ");

        await conn.query(
            "UPDATE Refunds SET status = 'succeeded', refund_method = 'mercado_pago', remark = ?, updated_at = ? WHERE refund_id = ?",
            [remark || "Approved refund", new Date(), refund.refund_id]
        );

        await setOrdersStatus(conn, [or_id], "REFUNDED", {
            remark: remark || "Refund approved",
        });

        const [refundItemRows] = await conn.query<(RowDataPacket & { oi_id: number; qty: number })[]>(
            "SELECT oi_id, qty FROM Refund_items WHERE refund_id = ?",
            [refund.refund_id]
        );
        const refundItemQtyMap = new Map(refundItemRows.map((row) => [Number(row.oi_id), Number(row.qty)]));
        await restockConsumedReservationsForItems(conn, or_id, refundItemQtyMap);

        await conn.commit();
        committed = true;

        const order = await adminGetOrderById(or_id, st_id, lg_code);
        if (!order) throw new ApiError(404, "No se encontró el pedido.");

        await notifyOrderEvent({
            event: "order:refund_approved",
            order,
            actor: "admin",
            targets: ["USER"],
            title: "Reembolso aprobado",
            message: `Se aprobó el reembolso del pedido ${order.order_no}.`,
            priority: "HIGH",
        });

        return order;
    } catch (err) {
        if (!committed) await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// admin ยกเลิกคำสั่งซื้อที่ยังรอชำระเงิน (PENDING) หรือชำระเงินแล้ว (CONFIRMED)
// PENDING: ยังไม่มีการชำระเงินจริง แค่ยกเลิกและปล่อย stock ที่จองไว้กลับคืน
// CONFIRMED: ชำระเงินแล้ว ต้องคืนเงินให้ลูกค้าผ่าน Mercado Pago อัตโนมัติด้วย
// ถ้าคืนอัตโนมัติไม่ได้ จะปิดออเดอร์เป็นยกเลิกไว้ก่อน แล้วให้ admin ยืนยันโอนคืนเองภายหลัง
export async function adminCancelOrder(or_id: number, st_id: number, note = "", lg_code = "es"): Promise<AdminOrderDetailDTO> {
    await ensureInventoryReservationTable();
    await ensureRefundMethodColumn();

    const conn = await pool.getConnection();
    let committed = false;

    try {
        await conn.beginTransaction();

        const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
        const params = st_id === ADMIN_ALL_STORE_ID ? [lg_code, or_id] : [lg_code, or_id, st_id];

        const [orderRows] = await conn.query<(RowDataPacket & OrderDTO)[]>(
            `${orderSelectSql} WHERE o.or_id = ? ${storeSql} LIMIT 1 FOR UPDATE`,
            params
        );

        const order = orderRows[0];
        if (!order) throw new ApiError(404, "No se encontró el pedido.");
        if (!ADMIN_CANCELLABLE_STATUS_CODES.includes(order.status_code as OrderStatusCode)) {
            throw new ApiError(400, "Solo se pueden cancelar pedidos pendientes de pago o ya pagados.");
        }
        if (order.refund_status === "pending") {
            throw new ApiError(400, "Este pedido ya tiene una solicitud de reembolso pendiente de revisión. Resuelve la solicitud de reembolso primero.");
        }

        const trimmedNote = note.trim();

        if (order.status_code === "PENDING") {
            await setOrdersStatus(conn, [or_id], "CANCELLED", {
                remark: trimmedNote ? `Admin cancel: ${trimmedNote}` : "Admin cancelled order",
            });
            await releaseReservationsForOrders(conn, [or_id]);
            await restoreCouponUsageForCancelledOrder(conn, order);

            await conn.commit();
            committed = true;

            const updated = await adminGetOrderById(or_id, st_id, lg_code);
            if (!updated) throw new ApiError(404, "No se encontró el pedido.");

            await notifyOrderEvent({
                event: "order:cancelled",
                order: updated,
                actor: "admin",
                targets: ["USER"],
                title: "Pedido cancelado",
                message: `El pedido ${updated.order_no} fue cancelado por la tienda.`,
                priority: "HIGH",
            });

            return updated;
        }

        const [paymentRows] = await conn.query<(RowDataPacket & { payment_ref: string | null })[]>(
            `SELECT p.payment_ref
             FROM Payments p
             INNER JOIN Payment_orders po ON po.pay_id = p.pay_id
             WHERE po.or_id = ?
               AND p.payment_status = 'paid'
             ORDER BY p.pay_id DESC
             LIMIT 1`,
            [or_id]
        );
        const paymentRef = paymentRows[0]?.payment_ref ?? null;
        if (!paymentRef) throw new ApiError(400, "No se encontró la referencia de pago para procesar el reembolso.");

        const [refundRes] = await conn.query<ResultSetHeader>(
            `INSERT INTO Refunds (or_id, payment_ref, amount, status, remark, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
            [or_id, paymentRef, Number(order.grand_total).toFixed(2), trimmedNote || "El administrador canceló el pedido.", new Date(), new Date()]
        );

        const [itemRows] = await conn.query<(RowDataPacket & OrderItemDTO)[]>(
            `${orderItemsSelectSql} WHERE oi.or_id = ? ORDER BY oi.oi_id ASC`,
            [lg_code, or_id]
        );
        if (itemRows.length > 0) {
            const refundItems = itemRows.map((item) => [
                refundRes.insertId,
                item.oi_id,
                item.qty,
                Number(item.line_total).toFixed(2),
                new Date(),
            ]);
            await conn.query(
                "INSERT INTO Refund_items (refund_id, oi_id, qty, amount, created_at) VALUES ?",
                [refundItems]
            );
        }

        let refundSucceeded = true;
        try {
            await createMercadoPagoRefund({
                paymentId: paymentRef,
                amount: Number(order.grand_total),
                metadata: {
                    order_id: String(or_id),
                    order_no: order.order_no,
                    refund_id: String(refundRes.insertId),
                },
            });
        } catch (err) {
            refundSucceeded = false;
            const details = err instanceof ApiError ? err.details as { code?: string; message?: string } : null;
            const providerMessage = details?.message || (err instanceof Error ? err.message : "No se pudo procesar el reembolso a través de Mercado Pago.");
            const failureRemark = [
                trimmedNote,
                `El reembolso a través de Mercado Pago no se completó: ${providerMessage}`,
                "Debe transferirse manualmente al cliente porque Mercado Pago rechazó o no admite el reembolso de este pedido.",
            ].filter(Boolean).join(" | ");

            await conn.query(
                "UPDATE Refunds SET status = 'failed', refund_method = 'manual', remark = ?, updated_at = ? WHERE refund_id = ?",
                [failureRemark, new Date(), refundRes.insertId]
            );
        }

        if (refundSucceeded) {
            const remark = [trimmedNote, "Reembolso realizado con éxito a través de Mercado Pago."].filter(Boolean).join(" | ");
            await conn.query(
                "UPDATE Refunds SET status = 'succeeded', refund_method = 'mercado_pago', remark = ?, updated_at = ? WHERE refund_id = ?",
                [remark, new Date(), refundRes.insertId]
            );
        }

        await setOrdersStatus(conn, [or_id], "CANCELLED", {
            remark: trimmedNote ? `Admin cancel: ${trimmedNote}` : "Admin cancelled order",
        });

        // order นี้ชำระเงินและกันสต๊อกไปแล้ว ต้องคืนสต๊อกกลับคลังเหมือน flow อนุมัติคืนเงิน
        await restockConsumedReservationsForOrders(conn, [or_id]);
        await restoreCouponUsageForCancelledOrder(conn, order);

        await conn.commit();
        committed = true;

        const updated = await adminGetOrderById(or_id, st_id, lg_code);
        if (!updated) throw new ApiError(404, "No se encontró el pedido.");

        await notifyOrderEvent({
            event: refundSucceeded ? "order:cancelled" : "order:refund_rejected",
            order: updated,
            actor: "admin",
            targets: ["USER"],
            title: "Pedido cancelado y reembolsado",
            message: refundSucceeded
                ? `El pedido ${updated.order_no} fue cancelado por la tienda y el reembolso se completó correctamente.`
                : `El pedido ${updated.order_no} fue cancelado por la tienda. El equipo realizará el reembolso manualmente.`,
            priority: "HIGH",
        });
        if (!refundSucceeded) await notifyPlatformManualRefundNeeded(updated);

        return updated;
    } catch (err) {
        if (!committed) await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// admin เปลี่ยนสถานะ order ตาม flow ร้าน เช่น PROCESSING/PACKED/READY_TO_SHIP
export async function adminUpdateOrderStatus(
    or_id: number,
    st_id: number,
    statusCode: OrderStatusCode,
    note = "",
    lg_code = "es"
): Promise<AdminOrderDetailDTO> {
    await ensureOrderShipmentLabelColumn();

    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
        const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

        const [rows] = await conn.query<(RowDataPacket & {
            or_id: number;
            order_no: string;
            status_code: string | null;
            refund_status: string | null;
        })[]>(
            `SELECT o.or_id, o.order_no, os.s_code AS status_code, latest_refund.status AS refund_status
             FROM Orders o
             LEFT JOIN Status os ON os.s_id = o.s_id
             LEFT JOIN (
                SELECT r1.or_id, r1.status
                FROM Refunds r1
                INNER JOIN (
                    SELECT or_id, MAX(refund_id) AS refund_id
                    FROM Refunds
                    GROUP BY or_id
                ) latest ON latest.refund_id = r1.refund_id
             ) latest_refund ON latest_refund.or_id = o.or_id
             WHERE o.or_id = ?
               ${storeSql}
             LIMIT 1
             FOR UPDATE`,
            params
        );

        const order = rows[0];
        if (!order) throw new ApiError(404, "No se encontró el pedido.");
        if (order.refund_status === "pending") {
            throw new ApiError(400, "Este pedido tiene una solicitud de reembolso pendiente de revisión. Resuelve la solicitud de reembolso primero.");
        }

        const currentCode = order.status_code ?? "";
        const allowedNext = ADMIN_STATUS_TRANSITIONS[currentCode];
        if (allowedNext !== statusCode) {
            throw new ApiError(400, `No se puede cambiar el estado de ${currentCode || "-"} a ${statusCode}`);
        }

        await setOrdersStatus(conn, [or_id], statusCode, {
            remark: note.trim() || `Admin changed status to ${statusCode}`,
        });

        if (statusCode === "READY_TO_SHIP") {
            await createShipmentForOrder(conn, or_id, st_id);
        }

        await conn.commit();

        const updated = await adminGetOrderById(or_id, st_id, lg_code);
        if (!updated) throw new ApiError(404, "No se encontró el pedido.");

        await notifyOrderEvent({
            event: "order:status_updated",
            order: updated,
            actor: "admin",
            targets: ["USER"],
            title: "Estado del pedido actualizado",
            message: `El pedido ${updated.order_no} cambió al estado: ${getOrderStatusLabel(updated)}.`,
            priority: statusCode === "READY_TO_SHIP" ? "HIGH" : "NORMAL",
        });

        return updated;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// สร้าง tracking URL จาก template ของ carrier และเลข tracking
function buildTrackingUrl(template: string | null | undefined, trackingNo: string): string | null {
    if (!template?.trim()) return null;

    // Phase 2: ยังไม่ยิง API ขนส่งจริง แต่ใช้ template ของ carrier เพื่อสร้างลิงก์ tracking ให้อัตโนมัติ
    // รองรับ placeholder หลัก {tracking_no}; ถ้า admin ใส่ URL ที่ไม่มี placeholder จะต่อเลขพัสดุท้าย URL ให้
    const trimmed = template.trim();
    if (trimmed.includes("{tracking_no}")) {
        return trimmed.replaceAll("{tracking_no}", encodeURIComponent(trackingNo));
    }

    const separator = trimmed.endsWith("/") ? "" : "/";
    return `${trimmed}${separator}${encodeURIComponent(trackingNo)}`;
}

// ตรวจเลขน้ำหนัก/ขนาดพัสดุว่ามีค่าเป็นบวกก่อนส่งไป shipping provider
function positiveShipmentNumber(value: unknown, label: string, productName: string): number {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue <= 0) {
        throw new ApiError(400, `El producto ${productName} no tiene ${label} registrado para crear el envío`);
    }
    return Math.ceil(numberValue);
}

// สร้าง shipment จริงผ่าน provider แล้วบันทึก shipment/item/label/tracking กลับเข้า order
async function createShipmentForOrder(
    conn: PoolConnection,
    or_id: number,
    st_id: number
): Promise<void> {
    await ensureOrderShipmentTables();
    await shippingService.ensureShippingCarrierProviderColumn();

    const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
    const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

    const [rows] = await conn.query<(RowDataPacket & {
        or_id: number;
        order_no: string;
        st_id: number;
        st_company_name: string | null;
        st_phone: string | null;
        st_email: string | null;
        status_code: string | null;
        shipping_name: string;
        shipping_phone: string;
        shipping_address: string;
        shipping_zip_code: string | null;
        shipping_province_name: string | null;
        shipping_district_name: string | null;
        shipping_subdistrict_name: string | null;
        grand_total: number;
        item_count: number;
        shipping_carrier_code: string | null;
        tracking_no: string | null;
        sender_address: string | null;
        sender_zip_code: string | null;
        sender_province_name: string | null;
        sender_district_name: string | null;
        sender_subdistrict_name: string | null;
    })[]>(
        `SELECT
            o.or_id,
            o.order_no,
            o.st_id,
            st.st_company_name,
            st.st_phone,
            st.st_email,
            os.s_code AS status_code,
            o.shipping_name,
            o.shipping_phone,
            o.shipping_address,
            lb.zip_code AS shipping_zip_code,
            lb.state AS shipping_province_name,
            COALESCE(lb.municipality, lb.city) AS shipping_district_name,
            lb.colonia AS shipping_subdistrict_name,
            o.grand_total,
            COUNT(oi.oi_id) AS item_count,
            sc.provider_code AS shipping_carrier_code,
            o.tracking_no,
            loc.loc_address AS sender_address,
            loc.zip_code AS sender_zip_code,
            loc.state AS sender_province_name,
            COALESCE(loc.municipality, loc.city) AS sender_district_name,
            loc.colonia AS sender_subdistrict_name
         FROM Orders o
         LEFT JOIN Store st ON st.st_id = o.st_id
         LEFT JOIN Status os ON os.s_id = o.s_id
         LEFT JOIN Shipping_carriers sc ON sc.sc_id = o.shipping_sc_id
         LEFT JOIN Order_items oi ON oi.or_id = o.or_id
         LEFT JOIN Locations_buyer lb
            ON lb.u_id = o.u_id
           AND lb.locb_recipient_name = o.shipping_name
           AND lb.locb_phone = o.shipping_phone
           AND lb.locb_address = o.shipping_address         LEFT JOIN Locations loc ON loc.st_id = o.st_id AND loc.is_default = 1         WHERE o.or_id = ?
           ${storeSql}
         GROUP BY o.or_id
         LIMIT 1
         FOR UPDATE`,
        params
    );

    const order = rows[0];
    if (!order) throw new ApiError(404, "No se encontró el pedido.");
    if (order.status_code !== "READY_TO_SHIP") {
        throw new ApiError(400, "El envío solo se puede crear después de cambiar el estado a READY_TO_SHIP.");
    }
    if (!order.shipping_carrier_code) throw new ApiError(400, "Este pedido aún no tiene información de envío.");
    if (order.tracking_no) throw new ApiError(400, "Este pedido ya tiene un número de guía.");

    if (!order.shipping_zip_code) {
        throw new ApiError(400, "Este pedido no tiene código postal del destinatario para crear el envío.");
    }

    let [shipmentRows] = await conn.query<(RowDataPacket & {
        os_id: number;
        shipment_no: string;
        sender_name: string;
        sender_phone: string | null;
        sender_email: string | null;
        sender_address: string;
        sender_zip_code: string | null;
        sender_province_name: string | null;
        sender_district_name: string | null;
        sender_subdistrict_name: string | null;
        recipient_name: string;
        recipient_phone: string | null;
        recipient_address: string;
        recipient_zip_code: string | null;
        recipient_province_name: string | null;
        recipient_district_name: string | null;
        recipient_subdistrict_name: string | null;
    })[]>(
        `SELECT
            os_id,
            shipment_no,
            sender_name,
            sender_phone,
            sender_email,
            sender_address,
            sender_zip_code,
            sender_province_name,
            sender_district_name,
            sender_subdistrict_name,
            recipient_name,
            recipient_phone,
            recipient_address,
            recipient_zip_code,
            recipient_province_name,
            recipient_district_name,
            recipient_subdistrict_name
         FROM Order_shipments
         WHERE or_id = ?
         ORDER BY os_id ASC
         FOR UPDATE`,
        [or_id]
    );

    if (!shipmentRows.length) {
        await createShipmentGroupsForOrders(conn, [or_id]);
        [shipmentRows] = await conn.query<typeof shipmentRows>(
            `SELECT
                os_id,
                shipment_no,
                sender_name,
                sender_phone,
                sender_email,
                sender_address,
                sender_zip_code,
                sender_province_name,
                sender_district_name,
                sender_subdistrict_name,
                recipient_name,
                recipient_phone,
                recipient_address,
                recipient_zip_code,
                recipient_province_name,
                recipient_district_name,
                recipient_subdistrict_name
             FROM Order_shipments
             WHERE or_id = ?
             ORDER BY os_id ASC
             FOR UPDATE`,
            [or_id]
        );
    }

    if (!shipmentRows.length) {
        throw new ApiError(400, "Este pedido aún no tiene información de envío según el almacén del que se descontó el stock.");
    }

    const trackingNos: string[] = [];
    const trackingUrls: string[] = [];
    const labelUrls: string[] = [];
    const statuses: string[] = [];

    for (const shipment of shipmentRows) {
        if (!shipment.sender_address || !shipment.sender_zip_code) {
            throw new ApiError(400, `El envío ${shipment.shipment_no} no tiene una dirección de remitente completa`);
        }
        if (!shipment.recipient_zip_code) {
            throw new ApiError(400, `El envío ${shipment.shipment_no} no tiene código postal del destinatario`);
        }

        const [itemRows] = await conn.query<(RowDataPacket & {
            sku: string | null;
            product_name: string;
            qty: number;
            unit_price: number;
            weight_g: number | null;
            length_cm: number | null;
            width_cm: number | null;
            height_cm: number | null;
        })[]>(
            `SELECT
                oi.sku,
                oi.product_name,
                osi.qty,
                oi.unit_price,
                pv.weight_g,
                pv.length_cm,
                pv.width_cm,
                pv.height_cm
             FROM Order_shipment_items osi
             INNER JOIN Order_items oi ON oi.oi_id = osi.oi_id
             INNER JOIN ProductVariants pv ON pv.pv_id = oi.pv_id
             WHERE osi.os_id = ?
             ORDER BY osi.osi_id ASC`,
            [shipment.os_id]
        );

        const firstItemName = itemRows[0]?.product_name ?? shipment.shipment_no;
        const totalQty = itemRows.reduce((sum, item) => sum + Number(item.qty ?? 0), 0);
        const totalWeightG = itemRows.reduce((sum, item) => {
            const productName = item.product_name || shipment.shipment_no;
            return sum + positiveShipmentNumber(item.weight_g, "peso", productName) * Number(item.qty ?? 1);
        }, 0);
        const maxWidthCm = Math.max(...itemRows.map((item) => positiveShipmentNumber(item.width_cm, "ancho", item.product_name || shipment.shipment_no)));
        const totalLengthCm = itemRows.reduce((sum, item) => {
            return sum + positiveShipmentNumber(item.length_cm, "longitud", item.product_name || shipment.shipment_no) * Number(item.qty ?? 1);
        }, 0);
        const maxHeightCm = Math.max(...itemRows.map((item) => positiveShipmentNumber(item.height_cm, "altura", item.product_name || shipment.shipment_no)));

        const result = await createSkydropxShipment({
            email: shipment.sender_email ?? order.st_email ?? "",
            orderNo: shipment.shipment_no,
            courierCode: order.shipping_carrier_code,
            from: {
                name: shipment.sender_name,
                address: shipment.sender_address,
                district: shipment.sender_subdistrict_name,
                state: shipment.sender_district_name,
                province: shipment.sender_province_name,
                postcode: shipment.sender_zip_code,
                tel: shipment.sender_phone ?? order.st_phone ?? "",
                email: shipment.sender_email ?? order.st_email,
            },
            to: {
                name: shipment.recipient_name,
                address: shipment.recipient_address,
                district: shipment.recipient_subdistrict_name,
                state: shipment.recipient_district_name,
                province: shipment.recipient_province_name,
                postcode: shipment.recipient_zip_code,
                tel: shipment.recipient_phone ?? order.shipping_phone,
            },
            parcel: {
                name: firstItemName,
                weight: totalWeightG,
                width: maxWidthCm,
                length: totalLengthCm,
                height: maxHeightCm,
            },
            products: itemRows.map((item, index) => ({
                product_code: item.sku ?? `${shipment.shipment_no}-${index + 1}`,
                name: item.product_name,
                price: Number(item.unit_price ?? 0),
                amount: Number(item.qty ?? 1),
                weight: positiveShipmentNumber(item.weight_g, "peso", item.product_name || shipment.shipment_no),
            })),
            declaredValue: Number(order.grand_total ?? 0),
            remark: `Order ${order.order_no} / ${shipment.shipment_no} (${Math.max(totalQty, 1)} items)`,
        });

        const displayTrackingNo = result.courierTrackingCode ?? result.providerShipmentId;

        await conn.query(
            `UPDATE Order_shipments
             SET tracking_no = ?,
                 tracking_url = ?,
                 label_url = ?,
                 status = ?,
                 updated_at = ?
             WHERE os_id = ?`,
            [displayTrackingNo, result.trackingUrl, result.labelUrl, result.shipmentStatus, new Date(), shipment.os_id]
        );

        trackingNos.push(displayTrackingNo);
        if (result.trackingUrl) trackingUrls.push(result.trackingUrl);
        if (result.labelUrl) labelUrls.push(result.labelUrl);
        if (result.shipmentStatus) statuses.push(result.shipmentStatus);
    }

    // Order-level tracking ยังเก็บไว้เพื่อ compatibility กับหน้ารายการเดิม ส่วนข้อมูลจริงรายกล่องอยู่ที่ Order_shipments
    await conn.query(
        `UPDATE Orders
         SET tracking_no = ?,
             tracking_url = ?,
             label_url = ?,
             shipment_status = ?,
             update_at = ?
         WHERE or_id = ?`,
        [
            trackingNos.join(", "),
            trackingUrls[0] ?? null,
            labelUrls[0] ?? null,
            Array.from(new Set(statuses)).join(", ") || "label_created",
            new Date(),
            or_id,
        ]
    );
}

// admin กรอกหรือแก้ไขเลข tracking เองเมื่อไม่ได้สร้าง shipment ผ่าน provider
export async function adminUpdateOrderTracking(
    or_id: number,
    st_id: number,
    trackingNoInput: string,
    lg_code = "es"
): Promise<AdminOrderDetailDTO> {
    await ensureOrderShipmentTables();

    const trackingNo = trackingNoInput.trim();
    if (trackingNo.length < 3) throw new ApiError(400, "Ingresa el número de guía.");

    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
        const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

        const [rows] = await conn.query<(RowDataPacket & {
            or_id: number;
            tracking_url_template: string | null;
        })[]>(
            `SELECT o.or_id, sc.tracking_url_template
             FROM Orders o
             LEFT JOIN Shipping_carriers sc ON sc.sc_id = o.shipping_sc_id
             WHERE o.or_id = ?
               ${storeSql}
             LIMIT 1
             FOR UPDATE`,
            params
        );

        const order = rows[0];
        if (!order) throw new ApiError(404, "No se encontró el pedido.");

        const trackingUrl = buildTrackingUrl(order.tracking_url_template, trackingNo);

        await conn.query(
            `UPDATE Orders
             SET tracking_no = ?,
                 tracking_url = ?,
                 shipment_status = COALESCE(NULLIF(shipment_status, ''), 'label_created'),
                 update_at = ?
             WHERE or_id = ?`,
            [trackingNo, trackingUrl, new Date(), or_id]
        );

        // ถ้า order มี shipment เดียว ให้เลขพัสดุที่แก้ด้วยมือ sync ลงกล่องนั้นด้วย
        // แต่ถ้ามีหลาย shipment จะไม่เดา เพราะแต่ละคลังควรมีเลขพัสดุแยกกัน
        const [shipmentCountRows] = await conn.query<(RowDataPacket & { cnt: number })[]>(
            "SELECT COUNT(*) AS cnt FROM Order_shipments WHERE or_id = ?",
            [or_id]
        );
        if (Number(shipmentCountRows[0]?.cnt ?? 0) === 1) {
            await conn.query(
                `UPDATE Order_shipments
                 SET tracking_no = ?,
                     tracking_url = ?,
                     status = COALESCE(NULLIF(status, ''), 'label_created'),
                     updated_at = ?
                 WHERE or_id = ?`,
                [trackingNo, trackingUrl, new Date(), or_id]
            );
        }

        await conn.commit();

        const updated = await adminGetOrderById(or_id, st_id, lg_code);
        if (!updated) throw new ApiError(404, "No se encontró el pedido.");

        await notifyOrderEvent({
            event: "order:tracking_updated",
            order: updated,
            actor: "admin",
            targets: ["USER"],
            title: "Número de seguimiento actualizado",
            message: `El pedido ${updated.order_no} tiene el número de seguimiento ${updated.tracking_no ?? trackingNo}.`,
            priority: "HIGH",
        });

        return updated;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// admin สร้าง shipment และเปลี่ยน order เป็น READY_TO_SHIP
// flow ปัจจุบันของ backoffice ยังไม่มีขั้น PACKED จึงรับ PROCESSING เป็นหลัก
// และคง PACKED ไว้เพื่อรองรับ order เก่าที่อาจอยู่ในสถานะนี้
export async function adminCreateOrderShipment(
    or_id: number,
    st_id: number,
    lg_code = "es"
): Promise<AdminOrderDetailDTO> {
    await ensureOrderShipmentLabelColumn();
    await ensureOrderShipmentTables();

    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
        const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

        const [rows] = await conn.query<(RowDataPacket & {
            or_id: number;
            status_code: string | null;
            refund_status: string | null;
        })[]>(
            `SELECT o.or_id, os.s_code AS status_code, latest_refund.status AS refund_status
             FROM Orders o
             LEFT JOIN Status os ON os.s_id = o.s_id
             LEFT JOIN (
                SELECT r1.or_id, r1.status
                FROM Refunds r1
                INNER JOIN (
                    SELECT or_id, MAX(refund_id) AS refund_id
                    FROM Refunds
                    GROUP BY or_id
                ) latest ON latest.refund_id = r1.refund_id
             ) latest_refund ON latest_refund.or_id = o.or_id
             WHERE o.or_id = ?
               ${storeSql}
             LIMIT 1
             FOR UPDATE`,
            params
        );

        const order = rows[0];
        if (!order) throw new ApiError(404, "No se encontró el pedido.");
        if (order.refund_status === "pending") {
            throw new ApiError(400, "Este pedido tiene una solicitud de reembolso pendiente de revisión. Resuelve la solicitud de reembolso primero.");
        }
        if (order.status_code !== "PROCESSING" && order.status_code !== "PACKED") {
            throw new ApiError(400, "El envío solo se puede crear desde el estado PROCESSING o PACKED.");
        }

        await setOrdersStatus(conn, [or_id], "READY_TO_SHIP", {
            remark: "Admin marked order ready to ship and shipment was created",
        });

        await createShipmentForOrder(conn, or_id, st_id);

        await conn.commit();

        const updated = await adminGetOrderById(or_id, st_id, lg_code);
        if (!updated) throw new ApiError(404, "No se encontró el pedido.");

        await notifyOrderEvent({
            event: "order:status_updated",
            order: updated,
            actor: "admin",
            targets: ["USER"],
            title: "Pedido listo para enviar",
            message: `El pedido ${updated.order_no} está listo para enviarse${updated.tracking_no ? `. Número de seguimiento: ${updated.tracking_no}` : ""}.`,
            priority: "HIGH",
        });

        return updated;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// action สำหรับ dev: จำลองว่า order จัดส่งสำเร็จและสร้าง event delivered
export async function adminDevMarkOrderDelivered(
    or_id: number,
    st_id: number,
    lg_code = "es"
): Promise<AdminOrderDetailDTO> {
    if (!allowDevShipmentActions()) {
        throw new ApiError(403, "Dev shipment actions are disabled");
    }

    await ensureOrderShipmentLabelColumn();
    await ensureOrderShipmentTables();

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
        const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

        const [orderRows] = await conn.query<(RowDataPacket & {
            or_id: number;
            status_code: string | null;
            refund_status: string | null;
        })[]>(
            `SELECT o.or_id, os.s_code AS status_code, latest_refund.status AS refund_status
             FROM Orders o
             LEFT JOIN Status os ON os.s_id = o.s_id
             LEFT JOIN (
                SELECT r1.or_id, r1.status
                FROM Refunds r1
                INNER JOIN (
                    SELECT or_id, MAX(refund_id) AS refund_id
                    FROM Refunds
                    GROUP BY or_id
                ) latest ON latest.refund_id = r1.refund_id
             ) latest_refund ON latest_refund.or_id = o.or_id
             WHERE o.or_id = ?
               ${storeSql}
             LIMIT 1
             FOR UPDATE`,
            params
        );

        const order = orderRows[0];
        if (!order) throw new ApiError(404, "No se encontró el pedido.");
        if (order.refund_status === "pending") {
            throw new ApiError(400, "Este pedido tiene una solicitud de reembolso pendiente de revisión. Resuelve la solicitud de reembolso primero.");
        }
        if (["CANCELLED", "REFUNDED"].includes(order.status_code ?? "")) {
            throw new ApiError(400, "No se puede simular una entrega exitosa para pedidos cancelados o reembolsados.");
        }

        const [shipmentRows] = await conn.query<(RowDataPacket & {
            os_id: number;
            tracking_no: string | null;
            tracking_url: string | null;
        })[]>(
            `SELECT os_id, tracking_no, tracking_url
             FROM Order_shipments
             WHERE or_id = ?
             ORDER BY os_id DESC
             LIMIT 1
             FOR UPDATE`,
            [or_id]
        );

        const shipment = shipmentRows[0];
        if (!shipment) {
            throw new ApiError(400, "Aún no hay un envío para este pedido. Crea un envío primero.");
        }

        const occurredAt = new Date();
        const state: ShippingTrackingState = {
            status: "POD",
            datetime: occurredAt.toISOString(),
            location: "DEV",
            description: "Delivery successfully, envío entregado con éxito (DEV)",
            raw: { dev_simulated: true },
        };
        const trackingCode = shipment.tracking_no ?? `DEV-${or_id}`;

        await conn.query(
            `INSERT INTO Order_shipment_events
             (os_id, or_id, tracking_code, courier_tracking_code, status, title, description, location, occurred_at, raw_json, event_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               tracking_code = VALUES(tracking_code),
               courier_tracking_code = VALUES(courier_tracking_code),
               title = VALUES(title),
               description = VALUES(description),
               location = VALUES(location),
               raw_json = VALUES(raw_json),
               updated_at = CURRENT_TIMESTAMP`,
            [
                Number(shipment.os_id),
                or_id,
                trackingCode,
                shipment.tracking_no,
                state.status,
                shipmentEventTitle(state.description),
                shipmentEventDescription(state.description),
                state.location,
                occurredAt,
                JSON.stringify(state.raw),
                eventHash(Number(shipment.os_id), state),
            ]
        );

        await conn.query(
            `UPDATE Order_shipments
             SET status = 'delivered',
                 updated_at = CURRENT_TIMESTAMP
             WHERE os_id = ?`,
            [shipment.os_id]
        );

        await conn.query(
            `UPDATE Orders o
             LEFT JOIN Status delivered_status ON delivered_status.s_code = 'DELIVERED'
             SET o.s_id = COALESCE(delivered_status.s_id, o.s_id),
                 o.status = 'delivered',
                 o.shipment_status = 'delivered',
                 o.update_at = CURRENT_TIMESTAMP
             WHERE o.or_id = ?`,
            [or_id]
        );

        await conn.commit();

        const updated = await adminGetOrderById(or_id, st_id, lg_code);
        if (!updated) throw new ApiError(404, "No se encontró el pedido.");

        await notifyOrderEvent({
            event: "order:status_updated",
            order: updated,
            actor: "admin",
            targets: ["USER"],
            title: "Entrega simulada completada",
            message: `El pedido ${updated.order_no} se marcó como entregado mediante una simulación para probar el sistema.`,
            priority: "NORMAL",
        });

        return updated;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// admin ปฏิเสธคำขอคืนเงิน/คืนสินค้า พร้อมบันทึกเหตุผลและแจ้ง buyer
export async function rejectRefundRequest(or_id: number, st_id: number, note: string, lg_code = "es"): Promise<AdminOrderDetailDTO> {
    if (note.trim().length < 3) throw new ApiError(400, "Indica el motivo del rechazo de la solicitud de reembolso.");

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
        const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

        const [rows] = await conn.query<(RowDataPacket & { refund_id: number; status_code: string | null })[]>(
            `SELECT r.refund_id, os.s_code AS status_code
             FROM Orders o
             LEFT JOIN Status os ON os.s_id = o.s_id
             INNER JOIN Refunds r ON r.or_id = o.or_id
             WHERE o.or_id = ?
               ${storeSql}
               AND r.status = 'pending'
             ORDER BY r.refund_id DESC
             LIMIT 1
             FOR UPDATE`,
            params
        );

        const refund = rows[0];
        if (!refund) throw new ApiError(404, "No se encontró una solicitud de reembolso pendiente.");

        await conn.query(
            "UPDATE Refunds SET status = 'failed', remark = ?, updated_at = ? WHERE refund_id = ?",
            [note.trim(), new Date(), refund.refund_id]
        );

        // ถ้าคำขอนี้เป็นการคืนสินค้าหลังจัดส่งแล้ว (ทำให้ order เข้าสถานะ RETURN_REQUESTED) พอปฏิเสธคำขอต้องย้อนกลับเป็น DELIVERED
        // ไม่งั้น order จะค้างอยู่ที่ RETURN_REQUESTED ตลอดไป ทำให้ buyer กดยืนยันรับสินค้าไม่ได้เลยทั้งที่ไม่มีอะไรจะคืนแล้ว
        if (refund.status_code === "RETURN_REQUESTED") {
            await setOrdersStatus(conn, [or_id], "DELIVERED", {
                remark: `Solicitud de devolución rechazada: ${note.trim()}`,
            });
        }

        await conn.commit();

        const order = await adminGetOrderById(or_id, st_id, lg_code);
        if (!order) throw new ApiError(404, "No se encontró el pedido.");

        await notifyOrderEvent({
            event: "order:refund_rejected",
            order,
            actor: "admin",
            targets: ["USER"],
            title: "Solicitud de reembolso rechazada",
            message: `La solicitud de reembolso del pedido ${order.order_no} fue rechazada. Motivo: ${note.trim()}`,
            priority: "HIGH",
        });

        return order;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// admin ยืนยันรับสินค้าคืน แล้วดำเนินการคืนเงินหรือบันทึกว่าให้โอนคืนเอง
export async function confirmReturnReceived(or_id: number, st_id: number, note = "", lg_code = "es"): Promise<AdminOrderDetailDTO> {
    await ensureInventoryReservationTable();
    await ensureRefundMethodColumn();

    const conn = await pool.getConnection();
    let committed = false;

    try {
        await conn.beginTransaction();

        const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
        const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

        const [rows] = await conn.query<(RowDataPacket & {
            or_id: number;
            order_no: string;
            status_code: string | null;
            payment_ref: string | null;
            refund_id: number;
            amount: number;
            return_tracking: string | null;
        })[]>(
            `SELECT o.or_id, o.order_no, os.s_code AS status_code, p.payment_ref,
                    r.refund_id, r.amount, r.return_tracking
             FROM Orders o
             LEFT JOIN Status os ON os.s_id = o.s_id
             INNER JOIN Refunds r ON r.or_id = o.or_id
             INNER JOIN Payment_orders po ON po.or_id = o.or_id
             INNER JOIN Payments p ON p.pay_id = po.pay_id
             WHERE o.or_id = ?
               ${storeSql}
               AND r.status = 'pending'
               AND p.payment_status = 'paid'
             ORDER BY r.refund_id DESC, p.pay_id DESC
             LIMIT 1
             FOR UPDATE`,
            params
        );

        const refund = rows[0];
        if (!refund) throw new ApiError(404, "No se encontró una solicitud de devolución pendiente.");
        // buyer อาจยืนยันรับสินค้า (RECEIVED) ไปแล้วระหว่างที่คำขอคืนบางรายการนี้ยังค้างอยู่ก็ได้ (แยกกันคนละเรื่อง) จึงรับสถานะนี้ด้วย ไม่ใช่แค่ RETURN_REQUESTED
        if (refund.status_code !== "RETURN_REQUESTED" && !ORDER_RECEIVED_STATUS_CODES.includes(refund.status_code as OrderStatusCode)) {
            throw new ApiError(400, "Este pedido no está en estado de espera de recepción de la devolución.");
        }
        if (!refund.return_tracking) {
            throw new ApiError(400, "Aún no hay número de guía para el producto que el cliente devolvió.");
        }
        if (!refund.payment_ref) throw new ApiError(400, "No se encontró la referencia de pago para procesar el reembolso.");

        try {
            await createMercadoPagoRefund({
                paymentId: refund.payment_ref,
                amount: Number(refund.amount),
                metadata: {
                    order_id: String(refund.or_id),
                    order_no: refund.order_no,
                    refund_id: String(refund.refund_id),
                    return_tracking: refund.return_tracking,
                },
            });
        } catch (err) {
            const details = err instanceof ApiError ? err.details as { code?: string; message?: string } : null;
            const providerMessage = details?.message || (err instanceof Error ? err.message : "No se pudo procesar el reembolso a través de Mercado Pago.");
            const failureRemark = [
                note.trim() ? `Producto devuelto recibido: ${note.trim()}` : "Producto devuelto recibido",
                `El reembolso a través de Mercado Pago no se completó: ${providerMessage}`,
                "Debe transferirse manualmente al cliente porque Mercado Pago rechazó o no admite el reembolso de este pedido.",
            ].filter(Boolean).join(" | ");

            await conn.query(
                "UPDATE Refunds SET status = 'failed', refund_method = 'manual', remark = ?, updated_at = ? WHERE refund_id = ?",
                [failureRemark, new Date(), refund.refund_id]
            );
            await conn.commit();
            committed = true;

            const order = await adminGetOrderById(or_id, st_id, lg_code);
            if (!order) throw new ApiError(404, "No se encontró el pedido.");

            await notifyOrderEvent({
                event: "order:refund_rejected",
                order,
                actor: "admin",
                targets: ["USER"],
                title: "Producto devuelto recibido",
                message: `La tienda recibió el producto devuelto del pedido ${order.order_no} y realizará el reembolso manualmente.`,
                priority: "HIGH",
            });
            await notifyPlatformManualRefundNeeded(order);

            return order;
        }

        const remark = [
            note.trim() ? `Producto devuelto recibido: ${note.trim()}` : "Producto devuelto recibido",
            "Reembolso realizado con éxito a través de Mercado Pago.",
        ].filter(Boolean).join(" | ");

        await conn.query(
            "UPDATE Refunds SET status = 'succeeded', refund_method = 'mercado_pago', remark = ?, updated_at = ? WHERE refund_id = ?",
            [remark, new Date(), refund.refund_id]
        );

        // ถ้ายังมีรายการในออเดอร์ที่ยังไม่ถูกคืนสำเร็จ (คืนบางรายการ) ให้กลับไปสถานะ DELIVERED แทนสถานะปิดจบ
        // เพื่อให้ buyer ยังยืนยันรับสินค้า/ยื่นคำขอคืนรายการที่เหลือได้ต่อ
        // แต่ถ้า buyer ยืนยันรับสินค้า (RECEIVED-tier) ไปแล้วก่อนหน้านี้ระหว่างที่คำขอนี้ยัง pending อยู่ ก็ไม่ต้องย้อนสถานะกลับ ปล่อยไว้อย่างเดิม
        const allReturned = await allOrderItemsReturned(conn, or_id);
        if (allReturned) {
            await setOrdersStatus(conn, [or_id], "RETURN_REQUESTED_COMPLETED", { remark });
        } else if (refund.status_code === "RETURN_REQUESTED") {
            await setOrdersStatus(conn, [or_id], "DELIVERED", { remark });
        }

        const [refundItemRows] = await conn.query<(RowDataPacket & { oi_id: number; qty: number })[]>(
            "SELECT oi_id, qty FROM Refund_items WHERE refund_id = ?",
            [refund.refund_id]
        );
        const refundItemQtyMap = new Map(refundItemRows.map((row) => [Number(row.oi_id), Number(row.qty)]));
        await restockConsumedReservationsForItems(conn, or_id, refundItemQtyMap);

        await conn.commit();
        committed = true;

        const order = await adminGetOrderById(or_id, st_id, lg_code);
        if (!order) throw new ApiError(404, "No se encontró el pedido.");

        await notifyOrderEvent({
            event: "order:refund_approved",
            order,
            actor: "admin",
            targets: ["USER"],
            title: "Devolución y reembolso completados",
            message: `La devolución y el reembolso del pedido ${order.order_no} se completaron correctamente.`,
            priority: "HIGH",
        });

        return order;
    } catch (err) {
        if (!committed) await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// admin ยืนยันว่าโอนเงินคืนแบบ manual เรียบร้อยแล้ว
export async function confirmManualRefundRequest(or_id: number, st_id: number, note = "", lg_code = "es"): Promise<AdminOrderDetailDTO> {
    await ensureInventoryReservationTable();
    await ensureRefundMethodColumn();

    const conn = await pool.getConnection();
    let committed = false;
    try {
        await conn.beginTransaction();

        const storeSql = st_id === ADMIN_ALL_STORE_ID ? "" : "AND o.st_id = ?";
        const params = st_id === ADMIN_ALL_STORE_ID ? [or_id] : [or_id, st_id];

        const [rows] = await conn.query<(RowDataPacket & {
            refund_id: number;
            remark: string | null;
            status_code: string | null;
            order_st_id: number;
        })[]>(
            `SELECT r.refund_id, r.remark, os.s_code AS status_code, o.st_id AS order_st_id
             FROM Orders o
             LEFT JOIN Status os ON os.s_id = o.s_id
             INNER JOIN Refunds r ON r.or_id = o.or_id
             WHERE o.or_id = ?
               ${storeSql}
               AND r.status = 'failed'
             ORDER BY r.refund_id DESC
             LIMIT 1
             FOR UPDATE`,
            params
        );

        const refund = rows[0];
        if (!refund) throw new ApiError(404, "No se encontró una solicitud de reembolso pendiente de transferencia manual.");
        if (!refund.remark?.includes("transferirse manualmente")) {
            throw new ApiError(400, "Esta solicitud de reembolso no corresponde a una transferencia manual.");
        }

        // ร้านที่ไม่ใช่ platform เองไม่ได้ถือเงินลูกค้าจริง (platform เป็น merchant of record ผ่าน Mercado Pago)
        // จึงต้องให้ผู้ดูแลระบบ platform เท่านั้นที่ยืนยันว่าโอนเงินคืนเองแล้วสำหรับ order ของร้านอื่น
        if (!(await isPlatformStore(refund.order_st_id)) && !(await isPlatformStore(st_id))) {
            throw new ApiError(403, "Solo un administrador de la plataforma puede confirmar la transferencia de reembolso para esta tienda.");
        }

        const remark = [
            refund.remark,
            note.trim() ? `Transferencia manual confirmada: ${note.trim()}` : "Transferencia manual confirmada",
        ].filter(Boolean).join(" | ");

        await conn.query(
            "UPDATE Refunds SET status = 'succeeded', remark = ?, updated_at = ? WHERE refund_id = ?",
            [remark, new Date(), refund.refund_id]
        );

        // buyer อาจยืนยันรับสินค้า (RECEIVED-tier) ไปแล้วก่อนหน้านี้ระหว่างที่คำขอคืนรายการนี้ยัง pending อยู่ก็ได้ ถือว่ายังเป็น return flow เหมือนกัน
        const isReturnFlow = refund.status_code === "RETURN_REQUESTED" || ORDER_RECEIVED_STATUS_CODES.includes(refund.status_code as OrderStatusCode);

        let manualRefundFinalStatus: OrderStatusCode | null;
        if (isReturnFlow) {
            const allReturned = await allOrderItemsReturned(conn, or_id);
            if (allReturned) {
                manualRefundFinalStatus = "RETURN_REQUESTED_COMPLETED";
            } else if (refund.status_code === "RETURN_REQUESTED") {
                // เหมือน confirmReturnReceived: ถ้าเป็นการคืนบางรายการและยังคืนไม่ครบทุกชิ้น ให้กลับไป DELIVERED แทนสถานะปิดจบ
                manualRefundFinalStatus = "DELIVERED";
            } else {
                // buyer ยืนยันรับสินค้าไปแล้วก่อนหน้า (RECEIVED-tier) และคืนไม่ครบ ไม่ต้องย้อน/เปลี่ยนสถานะออเดอร์ต่อ
                manualRefundFinalStatus = null;
            }
        } else {
            manualRefundFinalStatus = refund.status_code === "CANCELLED" ? "CANCELLED" : "REFUNDED";
        }

        if (manualRefundFinalStatus) {
            await setOrdersStatus(conn, [or_id], manualRefundFinalStatus, {
                remark,
            });
        }

        const [refundItemRows] = await conn.query<(RowDataPacket & { oi_id: number; qty: number })[]>(
            "SELECT oi_id, qty FROM Refund_items WHERE refund_id = ?",
            [refund.refund_id]
        );
        const refundItemQtyMap = new Map(refundItemRows.map((row) => [Number(row.oi_id), Number(row.qty)]));
        await restockConsumedReservationsForItems(conn, or_id, refundItemQtyMap);

        await conn.commit();
        committed = true;

        const order = await adminGetOrderById(or_id, st_id, lg_code);
        if (!order) throw new ApiError(404, "No se encontró el pedido.");

        await notifyOrderEvent({
            event: "order:refund_approved",
            order,
            actor: "admin",
            targets: ["USER"],
            title: "Reembolso al cliente confirmado",
            message: `Se confirmó que el reembolso del pedido ${order.order_no} fue transferido al cliente.`,
            priority: "HIGH",
        });

        return order;
    } catch (err) {
        if (!committed) await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// job batch: ยกเลิก order pending ที่หมดเวลาชำระ พร้อมคืน stock และคูปอง
export async function expirePendingPaymentOrders(limit = 50): Promise<number> {
    await ensureInventoryReservationTable();
    await ensureOrderShipmentLabelColumn();

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [expiredOrders] = await conn.query<(RowDataPacket & OrderDTO)[]>(
            `${orderSelectSql}
             WHERE os.s_code = 'PENDING'
               AND o.payment_expires_at IS NOT NULL
               AND o.payment_expires_at <= NOW()
             ORDER BY o.payment_expires_at ASC
             LIMIT ?
             FOR UPDATE`,
            ["th", limit]
        );

        const orderIds = expiredOrders.map((order) => Number(order.or_id));
        if (orderIds.length === 0) {
            await conn.commit();
            return 0;
        }

        // หมดเวลาชำระเงินแล้ว: ปิด order pending และคืน stock ที่เคย reserve ไว้
        await setOrdersStatus(conn, orderIds, "CANCELLED", { remark: "Payment expired" });

        await releaseReservationsForOrders(conn, orderIds);
        for (const order of expiredOrders) {
            await restoreCouponUsageForCancelledOrder(conn, order);
        }

        await conn.commit();

        await notifyManyOrderEvents(expiredOrders.map((order) => ({
            event: "order:payment_expired",
            order: {
                ...order,
                status_code: "CANCELLED",
                status_label: statusLabelByCode.CANCELLED ?? "Cancelado",
                status: toLegacyOrderStatus("CANCELLED"),
            },
            actor: "system",
            targets: ["STORE", "USER"],
            title: "Tiempo de pago agotado",
            message: `El pedido ${order.order_no} se canceló automáticamente porque venció el plazo de pago.`,
            priority: "NORMAL",
        })));

        return orderIds.length;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// job batch: เปลี่ยน DELIVERED เป็น AUTO_RECEIVED เมื่อครบกำหนดตรวจสอบและไม่มี refund pending
export async function autoReceiveDeliveredOrders(days = 14, limit = 100): Promise<number> {
    await ensureOrderShipmentTables();

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [orders] = await conn.query<(RowDataPacket & {
            or_id: number;
            order_no: string;
            st_id: number;
            u_id: number;
        })[]>(
            `SELECT o.or_id, o.order_no, o.st_id, o.u_id
             FROM Orders o
             INNER JOIN Status os ON os.s_id = o.s_id AND os.s_code = 'DELIVERED'
             LEFT JOIN (
                 SELECT
                     or_id,
                     MAX(occurred_at) AS delivered_at
                 FROM Order_shipment_events
                 WHERE status = 'POD'
                    OR LOWER(COALESCE(description, '')) LIKE '%delivery successfully%'
                 GROUP BY or_id
             ) delivered_event ON delivered_event.or_id = o.or_id
             WHERE DATE_ADD(COALESCE(delivered_event.delivered_at, o.update_at), INTERVAL ? DAY) <= NOW()
               AND NOT EXISTS (
                   SELECT 1 FROM Refunds r
                   WHERE r.or_id = o.or_id
                     AND r.status = 'pending'
               )
             ORDER BY COALESCE(delivered_event.delivered_at, o.update_at) ASC
             LIMIT ?
             FOR UPDATE`,
            [days, limit]
        );

        const orderIds = orders.map(order => Number(order.or_id));
        if (orderIds.length === 0) {
            await conn.commit();
            return 0;
        }

        await setOrdersStatus(conn, orderIds, "AUTO_RECEIVED", {
            remark: `Auto received after ${days} days`,
        });

        await conn.commit();

        await notifyManyOrderEvents(orders.map(order => ({
            event: "order:auto_received",
            order: {
                ...order,
                status: toLegacyOrderStatus("AUTO_RECEIVED"),
                status_code: "AUTO_RECEIVED",
                status_label: statusLabelByCode.AUTO_RECEIVED ?? null,
            },
            actor: "system",
            targets: ["USER", "STORE"],
            title: "Recepción confirmada automáticamente",
            message: `El plazo de revisión de ${days} días para el pedido ${order.order_no} finalizó, por lo que el sistema confirmó la recepción automáticamente.`,
            priority: "NORMAL",
        })));

        return orderIds.length;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

// เริ่ม background job สำหรับยืนยันรับสินค้าอัตโนมัติเป็นรอบ ๆ
export function startAutoReceiveDeliveredOrdersJob(intervalMs = 60 * 60 * 1000, days = 14): void {
    if (autoReceiveJobStarted) return;
    autoReceiveJobStarted = true;

    const run = async () => {
        try {
            const count = await autoReceiveDeliveredOrders(days);
            if (count > 0) {
                console.log(`[orders] auto received ${count} delivered order(s) after ${days} day(s)`);
            }
        } catch (err) {
            console.error("[orders] auto receive delivered orders failed:", err);
        }
    };

    void run();
    setInterval(() => { void run(); }, intervalMs);
}

/**
 * Job ตรวจสอบ order ที่รอชำระเงินแต่หมดเวลาแล้ว
 *
 * การทำงาน:
 *   - รันทันทีตอน server start เพื่อจัดการ order ค้างจากก่อนหน้า
 *   - วนซ้ำทุก intervalMs (default 60 วินาที) ตลอดอายุ process
 *   - แต่ละรอบเรียก expirePendingPaymentOrders() ซึ่ง:
 *       1. หา order ที่ status = รอชำระ และ payment_expires_at < NOW()
 *       2. เปลี่ยน status → CANCELLED
 *       3. คืน reserved stock inventory กลับ
 *       4. ส่ง notification แจ้งร้านค้าและผู้ซื้อ
 */
// เริ่ม background job สำหรับยกเลิก order ที่หมดเวลาชำระเงิน
export function startPaymentExpirationJob(intervalMs = 60_000): void {
    // ป้องกัน job ซ้ำหาก startPaymentExpirationJob() ถูกเรียกหลายครั้ง
    if (expirationJobStarted) return;
    expirationJobStarted = true;

    const run = async () => {
        try {
            const expiredCount = await expirePendingPaymentOrders();
            if (expiredCount > 0) {
                console.log(`[orders] expired ${expiredCount} pending payment order(s)`);
            }
        } catch (err) {
            console.error("[orders] expire pending payments failed:", err);
        }
    };

    // รันทันทีตอน API เริ่ม และวนซ้ำเพื่อคืน reserved_qty ของ order ที่เลยเวลาจ่าย
    void run();
    setInterval(() => { void run(); }, intervalMs);
}
