export type GoogleAnalyticsRange = "today" | "7d" | "30d" | "90d";

export type GoogleAnalyticsSummary = {
    active_users: number;
    total_users: number;
    new_users: number;
    sessions: number;
    screen_page_views: number;
    engagement_rate: number;
    average_session_duration: number;
    realtime_active_users: number;
};

export type GoogleAnalyticsTrend = {
    active_users_change: number | null;
    sessions_change: number | null;
    page_views_change: number | null;
};

export type GoogleAnalyticsDailyRow = {
    date: string;
    active_users: number;
    sessions: number;
    screen_page_views: number;
};

export type GoogleAnalyticsBreakdownRow = {
    name: string;
    active_users: number;
    sessions: number;
    screen_page_views: number;
};

export type GoogleAnalyticsTopPageRow = {
    path: string;
    screen_page_views: number;
    active_users: number;
};

export type GoogleAnalyticsDashboard = {
    property_id: string;
    range: GoogleAnalyticsRange;
    generated_at: string;
    google_analytics_url: string;
    summary: GoogleAnalyticsSummary;
    previous_summary: Pick<GoogleAnalyticsSummary, "active_users" | "sessions" | "screen_page_views">;
    trend: GoogleAnalyticsTrend;
    daily: GoogleAnalyticsDailyRow[];
    top_pages: GoogleAnalyticsTopPageRow[];
    channels: GoogleAnalyticsBreakdownRow[];
    devices: GoogleAnalyticsBreakdownRow[];
    countries: GoogleAnalyticsBreakdownRow[];
};
