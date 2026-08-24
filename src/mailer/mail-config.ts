import "dotenv/config";
import nodemailer from "nodemailer";
import type { MailConfig } from "./type.js";

export function getMailConfig(): MailConfig | null {
    const host = process.env.MAIL_HOST?.trim();
    const user = process.env.MAIL_USER?.trim();
    const pass = process.env.MAIL_PASS?.replace(/\s+/g, "");
    const fromEmail = process.env.MAIL_FROM_EMAIL?.trim() || user;

    if (!host || !user || !pass || !fromEmail) {
        console.warn("[mailer] skipped: MAIL_HOST, MAIL_USER, MAIL_PASS, or MAIL_FROM_EMAIL is missing");
        return null;
    }

    return {
        host,
        port: Number(process.env.MAIL_PORT ?? 587),
        secure: process.env.MAIL_SECURE === "true",
        user,
        pass,
        fromName: process.env.MAIL_FROM_NAME?.trim() || "Arcana",
        fromEmail,
    };
}

export function createTransporter(config: MailConfig | null = getMailConfig()) {
    if (!config) return null;

    return nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
            user: config.user,
            pass: config.pass,
        },
    });
}

export async function sendMail(input: {
    to: string | string[];
    subject: string;
    text: string;
    html: string;
}): Promise<void> {
    const config = getMailConfig();
    if (!config) {
        throw new Error("Mail configuration is missing");
    }
    const transporter = createTransporter(config);
    if (!transporter) {
        throw new Error("Mail transporter could not be created");
    }

    await transporter.sendMail({
        from: `"${config.fromName}" <${config.fromEmail}>`,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
    });
}
