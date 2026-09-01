import type { StoreEmailVerificationEmailInput } from "./type.js";
import { sendMail } from "./mail-config.js";
import { escapeHtml } from "./mail-utils.js";

function buildText(input: StoreEmailVerificationEmailInput): string {
    return [
        "Verifica el correo de contacto de la tienda",
        "",
        `Tienda: ${input.storeName}`,
        `Correo de la tienda: ${input.email}`,
        `Enlace de verificación de correo: ${input.verifyUrl}`,
        `El enlace caduca: ${input.expiresAt.toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}`,
        "",
        "Confirma para que Arcana use este correo como el canal oficial de contacto de tu tienda.",
    ].join("\n");
}

function buildHtml(input: StoreEmailVerificationEmailInput): string {
    const supportEmail = process.env.SUPPORT_EMAIL?.trim() || process.env.MAIL_FROM_EMAIL?.trim() || "-";

    return `
        <div style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,'Helvetica Neue',Tahoma,sans-serif;color:#111827;line-height:1.6;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;background:#f4f7fb;">
                <tr>
                    <td align="center" style="padding:32px 16px;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:680px;border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;box-shadow:0 18px 48px rgba(15,23,42,0.10);">
                            <tr>
                                <td style="padding:30px 32px;background:#0f172a;color:#ffffff;">
                                    <div style="font-size:22px;font-weight:800;">Arcana</div>
                                    <h1 style="margin:24px 0 8px;font-size:26px;line-height:1.35;">Verifica el correo de contacto de la tienda</h1>
                                    <p style="margin:0;color:#dbeafe;font-size:15px;">Confirma que este correo es un canal de contacto válido para tu tienda.</p>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding:30px 32px;">
                                    <p style="margin:0 0 8px;color:#64748b;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;">Store</p>
                                    <p style="margin:0 0 4px;color:#0f172a;font-size:24px;font-weight:800;">${escapeHtml(input.storeName)}</p>
                                    <p style="margin:0 0 24px;color:#334155;font-size:14px;">${escapeHtml(input.email)}</p>
                                    <p style="margin:0 0 20px;color:#334155;font-size:14px;">Haz clic en el siguiente botón para confirmar que este correo puede usarse como canal de contacto de la tienda.</p>
                                    <a href="${escapeHtml(input.verifyUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;padding:12px 18px;font-size:14px;font-weight:800;">Verificar correo de la tienda</a>
                                    <p style="margin:14px 0 0;color:#64748b;font-size:12px;line-height:1.5;">URL: <a href="${escapeHtml(input.verifyUrl)}" style="color:#1d4ed8;text-decoration:none;font-weight:700;">${escapeHtml(input.verifyUrl)}</a></p>
                                    <p style="margin:16px 0 0;color:#64748b;font-size:13px;">El enlace caduca: ${escapeHtml(input.expiresAt.toLocaleString("es-MX", { timeZone: "America/Mexico_City" }))}</p>
                                    <p style="margin:18px 0 0;color:#64748b;font-size:13px;">Si tú no solicitaste esto, contáctanos en <a href="mailto:${escapeHtml(supportEmail)}" style="color:#1d4ed8;text-decoration:none;font-weight:700;">${escapeHtml(supportEmail)}</a></p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </div>
    `;
}

export async function sendStoreEmailVerificationEmail(input: StoreEmailVerificationEmailInput): Promise<void> {
    await sendMail({
        to: input.email,
        subject: `Arcana: verifica el correo de la tienda ${input.storeName}`,
        text: buildText(input),
        html: buildHtml(input),
    });
}
