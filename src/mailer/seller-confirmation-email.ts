import type { SellerConfirmationEmailInput } from "./type.js";
import { sendMail } from "./mail-config.js";
import { escapeHtml } from "./mail-utils.js";

function buildText(input: SellerConfirmationEmailInput): string {
    return [
        "Confirma tu registro de consignador",
        "",
        `Tienda: ${input.storeName}`,
        `Enlace para confirmar tus datos y el aviso de privacidad: ${input.confirmUrl}`,
        `El enlace caduca: ${input.expiresAt.toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}`,
        "",
        "Revisa la información de tu tienda y acepta el aviso de privacidad antes de que el sistema envíe tu tienda a la cola de revisión.",
    ].join("\n");
}

function buildHtml(input: SellerConfirmationEmailInput): string {
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
                                    <h1 style="margin:24px 0 8px;font-size:26px;line-height:1.35;">Confirma tu registro de consignador</h1>
                                    <p style="margin:0;color:#dbeafe;font-size:15px;">El administrador ya completó la información inicial de tu tienda. Revísala y confírmala tú mismo.</p>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding:30px 32px;">
                                    <p style="margin:0 0 8px;color:#64748b;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;">Store</p>
                                    <p style="margin:0 0 24px;color:#0f172a;font-size:24px;font-weight:800;">${escapeHtml(input.storeName)}</p>
                                    <p style="margin:0 0 20px;color:#334155;font-size:14px;">Por seguridad y para dejar constancia conforme al aviso de privacidad (PDPA), abre el siguiente enlace para revisar la información de tu tienda y aceptar el aviso de privacidad tú mismo.</p>
                                    <a href="${escapeHtml(input.confirmUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;padding:12px 18px;font-size:14px;font-weight:800;">Revisar y confirmar información</a>
                                    <p style="margin:14px 0 0;color:#64748b;font-size:12px;line-height:1.5;">URL: <a href="${escapeHtml(input.confirmUrl)}" style="color:#1d4ed8;text-decoration:none;font-weight:700;">${escapeHtml(input.confirmUrl)}</a></p>
                                    <p style="margin:16px 0 0;color:#64748b;font-size:13px;">El enlace caduca: ${escapeHtml(input.expiresAt.toLocaleString("es-MX", { timeZone: "America/Mexico_City" }))}</p>
                                    <p style="margin:18px 0 0;color:#64748b;font-size:13px;">Si la información no es correcta, contáctanos en <a href="mailto:${escapeHtml(supportEmail)}" style="color:#1d4ed8;text-decoration:none;font-weight:700;">${escapeHtml(supportEmail)}</a></p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </div>
    `;
}

export async function sendSellerConfirmationEmail(input: SellerConfirmationEmailInput): Promise<void> {
    await sendMail({
        to: input.email,
        subject: `Arcana: confirma la información de tu tienda ${input.storeName}`,
        text: buildText(input),
        html: buildHtml(input),
    });
}
