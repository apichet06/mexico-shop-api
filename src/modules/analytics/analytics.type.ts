export type WebsiteAnalyticsEventName =
    | "page_view"
    | "product_view"
    | "coupon_view"
    | "coupon_collect"
    | "cart_view"
    | "add_to_cart"
    | "checkout_start"
    | "order_success";

export type WebsiteAnalyticsEventInput = {
    website_key: "arcana" | "deadstock" | "combined";
    event_name: WebsiteAnalyticsEventName;
    visitor_id: string;
    session_id: string;
    user_id?: number | null;
    path: string;
    referrer?: string | null;
    product_id?: number | null;
    coupon_id?: number | null;
    order_id?: number | null;
    metadata?: Record<string, unknown> | null;
};

export type WebsiteAnalyticsRange = "today" | "7d" | "30d" | "90d";

export type WebsiteAnalyticsSummary = {
    website_key: "arcana" | "deadstock" | "combined";
    range: WebsiteAnalyticsRange;
    page_views: number;
    unique_visitors: number;
    new_visitors: number;
    sessions: number;
    product_views: number;
    coupon_views: number;
    coupon_collects: number;
    cart_views: number;
    add_to_cart_count: number;
    checkout_start_count: number;
    order_success_count: number;
};

export type WebsiteAnalyticsDailyRow = {
    date: string;
    page_views: number;
    unique_visitors: number;
    sessions: number;
};

export type WebsiteAnalyticsTopPageRow = {
    path: string;
    page_views: number;
    unique_visitors: number;
};

export type WebsiteAnalyticsReport = {
    summary: WebsiteAnalyticsSummary;
    daily: WebsiteAnalyticsDailyRow[];
    top_pages: WebsiteAnalyticsTopPageRow[];
};
