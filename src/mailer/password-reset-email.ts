import type { PasswordResetEmailInput } from "./type.js";
import { sendMail } from "./mail-config.js";
import { escapeHtml, supportEmail } from "./mail-utils.js";

type PasswordResetBrand = {
    appName: string;
    title: string;
    intro: string;
    buttonText: string;
    subject: string;
    accent: string;
    background: string;
};

const employeeBrand: PasswordResetBrand = {
    appName: "Arcana Backoffice",
    title: "Restablecer contraseña",
    intro: "Usa el siguiente enlace para restablecer la contraseña de tu cuenta de Backoffice.",
    buttonText: "Restablecer contraseña",
    subject: "Arcana: restablece tu contraseña de Backoffice",
    accent: "#111827",
    background: "#f4f7fb",
};

const buyerBrand: PasswordResetBrand = {
    appName: "Arcana Shop",
    title: "Restablecer contraseña de tu cuenta",
    intro: "Usa el siguiente enlace para restablecer la contraseña de tu cuenta de Arcana Shop.",
    buttonText: "Restablecer contraseña",
    subject: "Arcana Shop: restablece tu contraseña",
    accent: "#1d4ed8",
    background: "#eff6ff",
};

function buildPasswordResetText(input: PasswordResetEmailInput, brand: PasswordResetBrand): string {
    return [
        brand.title,
        "",
        input.name ? `Hola ${input.name}` : "Hola",
        brand.intro,
        `Enlace para restablecer la contraseña: ${input.resetUrl}`,
        `Este enlace caduca en ${input.expiresInMinutes} minutos y solo se puede usar una vez.`,
        "",
        "Si no solicitaste este cambio, puedes ignorar este correo.",
        `Contacto: ${process.env.SUPPORT_EMAIL ?? process.env.MAIL_FROM_EMAIL ?? "-"}`,
    ].join("\n");
}

function buildPasswordResetHtml(input: PasswordResetEmailInput, brand: PasswordResetBrand): string {
    const contactEmail = supportEmail();

    return `
        <div style="margin:0;padding:0;background:${brand.background};font-family:Arial,'Helvetica Neue',Tahoma,sans-serif;color:#111827;line-height:1.6;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;background:${brand.background};">
                <tr>
                    <td align="center" style="padding:32px 16px;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #dbeafe;border-radius:12px;overflow:hidden;box-shadow:0 18px 48px rgba(15,23,42,0.10);">
                            <tr>
                                <td style="padding:28px 32px;background:${brand.accent};">
                                    <div style="display:inline-block;width:44px;height:44px;border-radius:10px;background:#ffffff;color:${brand.accent};text-align:center;line-height:44px;font-weight:800;font-size:22px;margin-right:12px;">A</div>
                                    <span style="color:#ffffff;font-size:22px;font-weight:800;vertical-align:middle;">${escapeHtml(brand.appName)}</span>
                                    <h1 style="margin:28px 0 8px;color:#ffffff;font-size:26px;line-height:1.3;font-weight:800;">${escapeHtml(brand.title)}</h1>
                                    <p style="margin:0;color:#dbeafe;font-size:15px;">${escapeHtml(brand.intro)}</p>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding:30px 32px;">
                                    <p style="margin:0 0 16px;color:#334155;font-size:15px;">${input.name ? `Hola ${escapeHtml(input.name)}` : "Hola"}</p>
                                    <p style="margin:0 0 20px;color:#334155;font-size:15px;">Recibimos una solicitud para restablecer la contraseña de la cuenta <strong>${escapeHtml(input.email)}</strong></p>
                                    <a href="${escapeHtml(input.resetUrl)}" style="display:inline-block;background:${brand.accent};color:#ffffff;text-decoration:none;border-radius:8px;padding:12px 18px;font-size:14px;font-weight:800;">${escapeHtml(brand.buttonText)}</a>
                                    <p style="margin:14px 0 0;color:#64748b;font-size:12px;line-height:1.5;">URL: <a href="${escapeHtml(input.resetUrl)}" style="color:#1d4ed8;text-decoration:none;font-weight:700;">${escapeHtml(input.resetUrl)}</a></p>

                                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:24px;border-collapse:separate;border-spacing:0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
                                        <tr>
                                            <td style="padding:16px 18px;color:#475569;font-size:13px;">
                                                Este enlace caduca en <strong>${input.expiresInMinutes} minutos</strong> y solo se puede usar una vez. Si no solicitaste este cambio, puedes ignorar este correo.
                                            </td>
                                        </tr>
                                    </table>

                                    <p style="margin:20px 0 0;color:#64748b;font-size:13px;">Si tienes alguna pregunta, contáctanos en <a href="mailto:${escapeHtml(contactEmail)}" style="color:#1d4ed8;text-decoration:none;font-weight:700;">${escapeHtml(contactEmail)}</a></p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </div>
    `;
}

async function sendPasswordResetEmail(input: PasswordResetEmailInput, brand: PasswordResetBrand): Promise<void> {
    await sendMail({
        to: input.email,
        subject: brand.subject,
        text: buildPasswordResetText(input, brand),
        html: buildPasswordResetHtml(input, brand),
    });
}

export function sendEmployeePasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
    return sendPasswordResetEmail(input, employeeBrand);
}

export function sendBuyerPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
    return sendPasswordResetEmail(input, buyerBrand);
}
