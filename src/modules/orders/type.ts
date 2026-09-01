import type { PaymentMethod } from "../payments/payment.type.js";
import type { CalculateResult } from "../shipping/shipping.type.js";

export type ShippingSelection = {
    st_id: number;
    sc_id: number;
};

export type CreateOrderInput = {
    u_id: number;
    locb_id: number;
    co_code?: string | null;
    shipping_selections?: ShippingSelection[];
    selected_ci_ids?: number[];
};

export type CheckoutOrderInput = CreateOrderInput & {
    payment_method: PaymentMethod;
};

export type StoreShippingOptions = {
    st_id: number;
    st_company_name: string;
    options: CalculateResult[];
};

export type OrderItemDTO = {
    oi_id: number;
    or_id: number;
    p_id: number;
    pv_id: number;
    sku: string | null;
    image_url?: string | null;
    product_name: string;
    variant_name: string | null;
    unit_price: number;
    discount_amount: number;
    qty: number;
    line_total: number;
    cost_snapshot: number;
    st_id?: number;
    ctl_id?: number;
    st_company_name?: string | null;
    is_reviewed: number;
    created_at: string;
    refunded_qty?: number;
};

export type RefundItemDTO = {
    oi_id: number;
    qty: number;
    amount: number;
    product_name?: string;
    variant_name?: string | null;
};

export type RefundHistoryEntryDTO = {
    refund_id: number;
    status: "pending" | "succeeded" | "failed";
    amount: number;
    remark: string | null;
    return_tracking: string | null;
    refund_method: "mercado_pago" | "omise" | "manual" | null;
    created_at: string;
    updated_at: string;
    items: RefundItemDTO[];
    images: string[];
};

export type OrderShipmentItemDTO = {
    osi_id: number;
    os_id: number;
    oi_id: number;
    pv_id: number;
    sku: string | null;
    product_name: string;
    variant_name: string | null;
    qty: number;
};

export type ShipmentEventDTO = {
    status?: string | null;
    title: string;
    description?: string | null;
    location?: string | null;
    occurred_at: string;
};

export type OrderShipmentDTO = {
    os_id: number;
    or_id: number;
    loc_id: number;
    shipment_no: string;
    status: string;
    tracking_no?: string | null;
    tracking_url?: string | null;
    label_url?: string | null;
    sender_name: string;
    sender_phone?: string | null;
    sender_email?: string | null;
    sender_address: string;
    sender_zip_code?: string | null;
    sender_province_name?: string | null;
    sender_district_name?: string | null;
    sender_subdistrict_name?: string | null;
    recipient_name: string;
    recipient_phone?: string | null;
    recipient_address: string;
    recipient_zip_code?: string | null;
    recipient_province_name?: string | null;
    recipient_district_name?: string | null;
    recipient_subdistrict_name?: string | null;
    item_count: number;
    total_qty: number;
    items?: OrderShipmentItemDTO[];
    events?: ShipmentEventDTO[];
};

export type OrderDTO = {
    or_id: number;
    order_no: string;
    u_id: number;
    cart_id: number;
    co_id: number | null;
    st_id: number;
    st_company_name?: string | null;
    st_is_platform_store?: boolean | 0 | 1 | "0" | "1" | null;
    s_id: number | null;
    status: string;
    status_code?: string | null;
    status_label?: string | null;
    refund_status?: "pending" | "succeeded" | "failed" | null;
    refund_id?: number | null;
    refund_amount?: number | null;
    refund_remark?: string | null;
    refund_method?: "mercado_pago" | "omise" | "manual" | null;
    refund_updated_at?: string | null;
    subtotal: number;
    discount_total: number;
    shipping_fee: number;
    provider_shipping_cost?: number | null;
    shipping_sc_id?: number | null;
    shipping_carrier_code?: string | null;
    shipping_carrier_name?: string | null;
    tracking_no?: string | null;
    tracking_url?: string | null;
    label_url?: string | null;
    tracking_url_template?: string | null;
    shipment_status?: string | null;
    shipment_events?: ShipmentEventDTO[];
    grand_total: number;
    coupon_code: string | null;
    shipping_name: string;
    shipping_phone: string;
    shipping_address: string;
    shipping_zip_code?: string | null;
    shipping_country_code?: string | null;
    shipping_state?: string | null;
    shipping_city?: string | null;
    shipping_municipality?: string | null;
    shipping_colonia?: string | null;
    shipping_province_name?: string | null;
    shipping_district_name?: string | null;
    shipping_subdistrict_name?: string | null;
    remark: string | null;
    payment_expires_at?: string | null;
    created_at: string;
    update_at: string;
};

export type AdminOrderDTO = OrderDTO & {
    customer_name: string;
    item_count: number;
};

export type AdminOrderSummaryDTO = {
    today_sales: number;
    new_orders: number;
    pending_orders: number;
    packing_orders: number;
    shipped_orders: number;
    coupon_discount_total: number;
};

export type AdminSalesReportRowDTO = {
    or_id: number;
    order_no: string;
    st_id: number;
    st_company_name: string | null;
    customer_name: string;
    status_code: string | null;
    status_label: string | null;
    sale_date: string;
    item_count: number;
    subtotal: number;
    discount_total: number;
    shipping_fee: number;
    grand_total: number;
    refund_total: number;
    net_sales: number;
    payment_method: string | null;
    payment_status: string | null;
};

export type AdminSalesReportSummaryDTO = {
    order_count: number;
    item_count: number;
    subtotal: number;
    discount_total: number;
    shipping_fee: number;
    gross_sales: number;
    refund_total: number;
    net_sales: number;
    average_order_value: number;
};

export type AdminSalesReportDTO = {
    summary: AdminSalesReportSummaryDTO;
    rows: AdminSalesReportRowDTO[];
};

export type AdminSalesByProductRowDTO = {
    p_id: number;
    pv_id: number;
    sku: string | null;
    product_name: string;
    variant_name: string | null;
    st_id: number | null;
    st_company_name: string | null;
    order_count: number;
    qty_sold: number;
    gross_sales: number;
    discount_total: number;
    net_sales: number;
    average_unit_price: number;
};

export type AdminSalesByProductSummaryDTO = {
    product_count: number;
    order_count: number;
    qty_sold: number;
    gross_sales: number;
    discount_total: number;
    net_sales: number;
};

export type AdminSalesByProductReportDTO = {
    summary: AdminSalesByProductSummaryDTO;
    rows: AdminSalesByProductRowDTO[];
};

export type AdminSalesByCategoryRowDTO = {
    c_id: number;
    category_name: string;
    catalog_name: string | null;
    order_count: number;
    product_count: number;
    qty_sold: number;
    gross_sales: number;
    discount_total: number;
    net_sales: number;
    average_unit_price: number;
};

export type AdminSalesByCategorySummaryDTO = {
    category_count: number;
    order_count: number;
    product_count: number;
    qty_sold: number;
    gross_sales: number;
    discount_total: number;
    net_sales: number;
};

export type AdminSalesByCategoryReportDTO = {
    summary: AdminSalesByCategorySummaryDTO;
    rows: AdminSalesByCategoryRowDTO[];
};

export type AdminSalesByBuyerRowDTO = {
    u_id: number;
    customer_name: string;
    st_id: number;
    st_company_name: string | null;
    order_count: number;
    item_count: number;
    gross_sales: number;
    discount_total: number;
    refund_total: number;
    net_sales: number;
    average_order_value: number;
    latest_sale_date: string | null;
};

export type AdminSalesByBuyerSummaryDTO = {
    buyer_count: number;
    store_count: number;
    order_count: number;
    item_count: number;
    gross_sales: number;
    discount_total: number;
    refund_total: number;
    net_sales: number;
    average_per_buyer: number;
    repeat_buyer_count: number;
    repeat_buyer_rate: number;
};

export type AdminSalesByBuyerReportDTO = {
    summary: AdminSalesByBuyerSummaryDTO;
    rows: AdminSalesByBuyerRowDTO[];
};

export type OrderDetailDTO = OrderDTO & {
    items: OrderItemDTO[];
    shipments?: OrderShipmentDTO[];
    refund_items?: RefundItemDTO[];
};
