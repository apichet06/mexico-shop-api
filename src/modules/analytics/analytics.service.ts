import crypto from "crypto";
import { pool } from "../../db/pool.js";
import type {
    WebsiteAnalyticsDailyRow,
    WebsiteAnalyticsEventInput,
    WebsiteAnalyticsRange,
    WebsiteAnalyticsReport,
    WebsiteAnalyticsTopPageRow,
} from "./analytics.type.js";

const HASH_SALT = process.env.ANALYTICS_HASH_SALT || process.env.DB_NAME || "arcana-analytics";

function sha256(value: string): string {
    return crypto
        .createHash("sha256")
        .update(`${HASH_SALT}:${value}`)
        .digest("hex");
}

function compactUserAgent(userAgent?: string): string | null {
    if (!userAgent) return null;
    return userAgent.slice(0, 255);
}

function normalizeIp(ip?: string | null): string | null {
    if (!ip) return null;
    const firstIp = ip.split(",")[0]?.trim();
    return firstIp || null;
}

function safeDecodeUrl(value: string): string {
    try {
        return decodeURI(value);
    } catch {
        return value;
    }
}

export async function recordEvent(input: WebsiteAnalyticsEventInput, context: { ip?: string | null; userAgent?: string | null }): Promise<void> {
    const ip = normalizeIp(context.ip);

    // เก็บเฉพาะ hash เพื่อใช้ dedupe/aggregate ได้ โดยไม่บันทึก visitor id หรือ IP ดิบลงฐานข้อมูล
    const visitorIdHash = sha256(input.visitor_id);
    const ipHash = ip ? sha256(ip) : null;

    await pool.query(
        `INSERT INTO website_analytics_events (
            website_key,
            event_name,
            visitor_id_hash,
            session_id,
            user_id,
            path,
            referrer,
            product_id,
            coupon_id,
            order_id,
            metadata,
            user_agent_summary,
            ip_hash
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            input.website_key,
            input.event_name,
            visitorIdHash,
            input.session_id,
            input.user_id ?? null,
            input.path,
            input.referrer ?? null,
            input.product_id ?? null,
            input.coupon_id ?? null,
            input.order_id ?? null,
            input.metadata ? JSON.stringify(input.metadata) : null,
            compactUserAgent(context.userAgent ?? undefined),
            ipHash,
        ]
    );
}

function getRangeSql(range: WebsiteAnalyticsRange) {
    if (range === "today") return "DATE(created_at) >= CURDATE()";
    if (range === "30d") return "DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)";
    if (range === "90d") return "DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 89 DAY)";
    return "DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)";
}

function dateToYmd(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function normalizeDateKey(value: unknown) {
    if (value instanceof Date) return dateToYmd(value);
    return String(value).slice(0, 10);
}

function getRangeDays(range: WebsiteAnalyticsRange) {
    if (range === "today") return 1;
    if (range === "30d") return 30;
    if (range === "90d") return 90;
    return 7;
}

function getPresetStartDate(range: WebsiteAnalyticsRange) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    today.setDate(today.getDate() - (getRangeDays(range) - 1));
    return dateToYmd(today);
}

function getTodayYmd() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return dateToYmd(today);
}

function parseYmd(value: string) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

function getDateFilter(params: { range: WebsiteAnalyticsRange; startDate?: string; endDate?: string }) {
    if (!params.startDate) {
        return {
            sql: getRangeSql(params.range),
            values: [] as string[],
            startDate: getPresetStartDate(params.range),
            endDate: getTodayYmd(),
        };
    }

    const endDate = params.endDate || getTodayYmd();
    return {
        sql: "DATE(created_at) BETWEEN ? AND ?",
        values: [params.startDate, endDate],
        startDate: params.startDate,
        endDate,
    };
}

function buildDailySeries(startDate: string, endDate: string, rows: any[]): WebsiteAnalyticsDailyRow[] {
    const rowsByDate = new Map(
        rows.map((row) => [
            normalizeDateKey(row.date),
            {
                date: normalizeDateKey(row.date),
                page_views: toNumber(row.page_views),
                unique_visitors: toNumber(row.unique_visitors),
                sessions: toNumber(row.sessions),
            },
        ])
    );
    const start = parseYmd(startDate);
    const end = parseYmd(endDate);
    const days = Math.max(Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1, 1);

    // เติมวันที่ไม่มี event เป็น 0 เพื่อให้ chart แสดงช่วงวันที่ตาม filter เสมอ
    return Array.from({ length: days }, (_, index) => {
        const date = new Date(start);
        date.setHours(0, 0, 0, 0);
        date.setDate(start.getDate() + index);
        const key = dateToYmd(date);

        return rowsByDate.get(key) ?? {
            date: key,
            page_views: 0,
            unique_visitors: 0,
            sessions: 0,
        };
    });
}

function toNumber(value: unknown) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : 0;
}

export async function getAdminReport(params: {
    websiteKey: "arcana" | "deadstock" | "combined";
    range: WebsiteAnalyticsRange;
    startDate?: string;
    endDate?: string;
}): Promise<WebsiteAnalyticsReport> {
    const dateFilter = getDateFilter(params);

    const [summaryRows] = await pool.query<any[]>(
        `SELECT
            COUNT(CASE WHEN event_name = 'page_view' THEN 1 END) AS page_views,
            COUNT(DISTINCT visitor_id_hash) AS unique_visitors,
            COUNT(DISTINCT session_id) AS sessions,
            COUNT(CASE WHEN event_name = 'product_view' THEN 1 END) AS product_views,
            COUNT(CASE WHEN event_name = 'coupon_view' THEN 1 END) AS coupon_views,
            COUNT(CASE WHEN event_name = 'coupon_collect' THEN 1 END) AS coupon_collects,
            COUNT(CASE WHEN event_name = 'cart_view' THEN 1 END) AS cart_views,
            COUNT(CASE WHEN event_name = 'add_to_cart' THEN 1 END) AS add_to_cart_count,
            COUNT(CASE WHEN event_name = 'checkout_start' THEN 1 END) AS checkout_start_count,
            COUNT(CASE WHEN event_name = 'order_success' THEN 1 END) AS order_success_count
         FROM website_analytics_events
         WHERE website_key = ?
           AND ${dateFilter.sql}`,
        [params.websiteKey, ...dateFilter.values]
    );

    const [dailyRows] = await pool.query<any[]>(
        `SELECT
            DATE(created_at) AS date,
            COUNT(CASE WHEN event_name = 'page_view' THEN 1 END) AS page_views,
            COUNT(DISTINCT visitor_id_hash) AS unique_visitors,
            COUNT(DISTINCT session_id) AS sessions
         FROM website_analytics_events
         WHERE website_key = ?
           AND ${dateFilter.sql}
         GROUP BY DATE(created_at)
         ORDER BY DATE(created_at) ASC`,
        [params.websiteKey, ...dateFilter.values]
    );

    const [newVisitorRows] = await pool.query<any[]>(
        `SELECT COUNT(*) AS new_visitors
         FROM (
            SELECT visitor_id_hash, MIN(DATE(created_at)) AS first_seen_date
            FROM website_analytics_events
            WHERE website_key = ?
            GROUP BY visitor_id_hash
         ) AS first_seen
         WHERE first_seen_date BETWEEN ? AND ?`,
        [params.websiteKey, dateFilter.startDate, dateFilter.endDate]
    );

    const [topPageRows] = await pool.query<any[]>(
        `SELECT
            path,
            COUNT(*) AS page_views,
            COUNT(DISTINCT visitor_id_hash) AS unique_visitors
         FROM website_analytics_events
         WHERE website_key = ?
           AND event_name = 'page_view'
           AND ${dateFilter.sql}
         GROUP BY path
         ORDER BY page_views DESC, unique_visitors DESC
         LIMIT 10`,
        [params.websiteKey, ...dateFilter.values]
    );

    const summary = summaryRows[0] ?? {};
    const newVisitorSummary = newVisitorRows[0] ?? {};
    return {
        summary: {
            website_key: params.websiteKey,
            range: params.range,
            page_views: toNumber(summary.page_views),
            unique_visitors: toNumber(summary.unique_visitors),
            new_visitors: toNumber(newVisitorSummary.new_visitors),
            sessions: toNumber(summary.sessions),
            product_views: toNumber(summary.product_views),
            coupon_views: toNumber(summary.coupon_views),
            coupon_collects: toNumber(summary.coupon_collects),
            cart_views: toNumber(summary.cart_views),
            add_to_cart_count: toNumber(summary.add_to_cart_count),
            checkout_start_count: toNumber(summary.checkout_start_count),
            order_success_count: toNumber(summary.order_success_count),
        },
        daily: buildDailySeries(dateFilter.startDate, dateFilter.endDate, dailyRows),
        top_pages: topPageRows.map((row): WebsiteAnalyticsTopPageRow => ({
            path: safeDecodeUrl(String(row.path ?? "-")),
            page_views: toNumber(row.page_views),
            unique_visitors: toNumber(row.unique_visitors),
        })),
    };
}
