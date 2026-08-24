export function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export function uniqueEmails(emails: string[]): string[] {
    return Array.from(new Set(emails.map((email) => email.trim()).filter(Boolean)));
}

export function supportEmail(): string {
    return process.env.SUPPORT_EMAIL?.trim() || process.env.MAIL_FROM_EMAIL?.trim() || "-";
}
