import { BetaAnalyticsDataClient } from "@google-analytics/data";
import { ApiError } from "../../shared/errors/ApiError.js";
import type {
    GoogleAnalyticsBreakdownRow,
    GoogleAnalyticsDailyRow,
    GoogleAnalyticsDashboard,
    GoogleAnalyticsRange,
    GoogleAnalyticsSummary,
    GoogleAnalyticsTopPageRow,
} from "./google-analytics.type.js";

const PROPERTY_ID = process.env.GA4_PROPERTY_ID?.trim() ?? "";
const GOOGLE_ANALYTICS_URL = PROPERTY_ID
    ? `https://analytics.google.com/analytics/web/#/p${PROPERTY_ID}/reports/intelligenthome`
    : "https://analytics.google.com/analytics/web/";

let analyticsClient: BetaAnalyticsDataClient | null = null;

function hasExplicitCredentials() {
    return Boolean(
        process.env.GOOGLE_APPLICATION_CREDENTIALS ||
        (process.env.GA_CLIENT_EMAIL && process.env.GA_PRIVATE_KEY)
    );
}

function getClient() {
    if (!PROPERTY_ID) {
        throw new ApiError(503, "ยังไม่ได้ตั้งค่า GA4_PROPERTY_ID");
    }
    if (!hasExplicitCredentials()) {
        throw new ApiError(503, "ยังไม่ได้ตั้งค่า credential สำหรับ Google Analytics Data API");
    }
    if (analyticsClient) return analyticsClient;

    if (process.env.GA_CLIENT_EMAIL && process.env.GA_PRIVATE_KEY) {
        analyticsClient = new BetaAnalyticsDataClient({
            credentials: {
                client_email: process.env.GA_CLIENT_EMAIL,
                private_key: process.env.GA_PRIVATE_KEY.replace(/\\n/g, "\n"),
            },
        });
        return analyticsClient;
    }

    analyticsClient = new BetaAnalyticsDataClient();
    return analyticsClient;
}

function getDateRange(range: GoogleAnalyticsRange) {
    if (range === "today") return { startDate: "today", endDate: "today" };
    if (range === "30d") return { startDate: "29daysAgo", endDate: "today" };
    if (range === "90d") return { startDate: "89daysAgo", endDate: "today" };
    return { startDate: "6daysAgo", endDate: "today" };
}

function getPreviousDateRange(range: GoogleAnalyticsRange) {
    if (range === "today") return { startDate: "yesterday", endDate: "yesterday" };
    if (range === "30d") return { startDate: "59daysAgo", endDate: "30daysAgo" };
    if (range === "90d") return { startDate: "179daysAgo", endDate: "90daysAgo" };
    return { startDate: "13daysAgo", endDate: "7daysAgo" };
}

function numberValue(value: unknown) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

function metric(row: any, index: number) {
    return numberValue(row?.metricValues?.[index]?.value);
}

function dimension(row: any, index: number, fallback = "-") {
    const value = String(row?.dimensionValues?.[index]?.value ?? "").trim();
    return value || fallback;
}

function percentChange(current: number, previous: number) {
    if (!previous) return current ? null : 0;
    return ((current - previous) / previous) * 100;
}

function normalizeGaDate(value: string) {
    if (/^\d{8}$/.test(value)) {
        return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    }
    return value;
}

async function runSummary(range: GoogleAnalyticsRange): Promise<GoogleAnalyticsSummary> {
    const client = getClient();
    const [response] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [getDateRange(range)],
        metrics: [
            { name: "activeUsers" },
            { name: "totalUsers" },
            { name: "newUsers" },
            { name: "sessions" },
            { name: "screenPageViews" },
            { name: "engagementRate" },
            { name: "averageSessionDuration" },
        ],
    });
    const row = response.rows?.[0];

    return {
        active_users: metric(row, 0),
        total_users: metric(row, 1),
        new_users: metric(row, 2),
        sessions: metric(row, 3),
        screen_page_views: metric(row, 4),
        engagement_rate: metric(row, 5),
        average_session_duration: metric(row, 6),
        realtime_active_users: 0,
    };
}

async function runPreviousSummary(range: GoogleAnalyticsRange) {
    const client = getClient();
    const [response] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [getPreviousDateRange(range)],
        metrics: [
            { name: "activeUsers" },
            { name: "sessions" },
            { name: "screenPageViews" },
        ],
    });
    const row = response.rows?.[0];

    return {
        active_users: metric(row, 0),
        sessions: metric(row, 1),
        screen_page_views: metric(row, 2),
    };
}

async function runRealtimeActiveUsers() {
    const client = getClient();
    const [response] = await client.runRealtimeReport({
        property: `properties/${PROPERTY_ID}`,
        metrics: [{ name: "activeUsers" }],
    });
    return metric(response.rows?.[0], 0);
}

async function runDaily(range: GoogleAnalyticsRange): Promise<GoogleAnalyticsDailyRow[]> {
    const client = getClient();
    const [response] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [getDateRange(range)],
        dimensions: [{ name: "date" }],
        metrics: [
            { name: "activeUsers" },
            { name: "sessions" },
            { name: "screenPageViews" },
        ],
        orderBys: [{ dimension: { dimensionName: "date" } }],
    });

    return (response.rows ?? []).map((row) => ({
        date: normalizeGaDate(dimension(row, 0)),
        active_users: metric(row, 0),
        sessions: metric(row, 1),
        screen_page_views: metric(row, 2),
    }));
}

async function runTopPages(range: GoogleAnalyticsRange): Promise<GoogleAnalyticsTopPageRow[]> {
    const client = getClient();
    const [response] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [getDateRange(range)],
        dimensions: [{ name: "pagePathPlusQueryString" }],
        metrics: [
            { name: "screenPageViews" },
            { name: "activeUsers" },
        ],
        orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
        limit: 10,
    });

    return (response.rows ?? []).map((row) => ({
        path: dimension(row, 0),
        screen_page_views: metric(row, 0),
        active_users: metric(row, 1),
    }));
}

async function runBreakdown(range: GoogleAnalyticsRange, dimensionName: string): Promise<GoogleAnalyticsBreakdownRow[]> {
    const client = getClient();
    const [response] = await client.runReport({
        property: `properties/${PROPERTY_ID}`,
        dateRanges: [getDateRange(range)],
        dimensions: [{ name: dimensionName }],
        metrics: [
            { name: "activeUsers" },
            { name: "sessions" },
            { name: "screenPageViews" },
        ],
        orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
        limit: 8,
    });

    return (response.rows ?? []).map((row) => ({
        name: dimension(row, 0),
        active_users: metric(row, 0),
        sessions: metric(row, 1),
        screen_page_views: metric(row, 2),
    }));
}

export async function getDashboard(range: GoogleAnalyticsRange): Promise<GoogleAnalyticsDashboard> {
    try {
        const [
            summary,
            previousSummary,
            realtimeActiveUsers,
            daily,
            topPages,
            channels,
            devices,
            countries,
        ] = await Promise.all([
            runSummary(range),
            runPreviousSummary(range),
            runRealtimeActiveUsers(),
            runDaily(range),
            runTopPages(range),
            runBreakdown(range, "sessionDefaultChannelGroup"),
            runBreakdown(range, "deviceCategory"),
            runBreakdown(range, "country"),
        ]);

        return {
            property_id: PROPERTY_ID,
            range,
            generated_at: new Date().toISOString(),
            google_analytics_url: GOOGLE_ANALYTICS_URL,
            summary: {
                ...summary,
                realtime_active_users: realtimeActiveUsers,
            },
            previous_summary: previousSummary,
            trend: {
                active_users_change: percentChange(summary.active_users, previousSummary.active_users),
                sessions_change: percentChange(summary.sessions, previousSummary.sessions),
                page_views_change: percentChange(summary.screen_page_views, previousSummary.screen_page_views),
            },
            daily,
            top_pages: topPages,
            channels,
            devices,
            countries,
        };
    } catch (error: any) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, "ไม่สามารถดึงข้อมูลจาก Google Analytics ได้", {
            message: error?.message,
            code: error?.code,
        });
    }
}
