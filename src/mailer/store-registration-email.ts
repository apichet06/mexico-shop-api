import type { StoreRegistrationEmailInput, StoreRegistrationMember } from "./type.js";
import { sendMail } from "./mail-config.js";
import { escapeHtml, uniqueEmails } from "./mail-utils.js";

function statusLabel(status: string): string {
    const map: Record<string, string> = {
        PENDING: "Pendiente de revisión",
        ACTIVE: "Aprobado, listo para usar",
        REQUEST: "Se requieren documentos adicionales",
        UPLOAD: "Documentos enviados, en revisión",
        REJECTED: "Solicitud rechazada",
        SUSPENDED: "Cuenta suspendida",
    };
    return map[status] ?? status;
}

function statusTheme(status: string): { background: string; border: string; color: string } {
    const map: Record<string, { background: string; border: string; color: string }> = {
        PENDING: { background: "#fff7ed", border: "#fed7aa", color: "#9a3412" },
        ACTIVE: { background: "#ecfdf5", border: "#a7f3d0", color: "#047857" },
        REQUEST: { background: "#eff6ff", border: "#bfdbfe", color: "#1d4ed8" },
        UPLOAD: { background: "#f5f3ff", border: "#ddd6fe", color: "#6d28d9" },
        REJECTED: { background: "#fef2f2", border: "#fecaca", color: "#b91c1c" },
        SUSPENDED: { background: "#f8fafc", border: "#cbd5e1", color: "#475569" },
    };
    return map[status] ?? { background: "#f8fafc", border: "#e2e8f0", color: "#334155" };
}

function memberName(member: StoreRegistrationMember): string {
    return [member.firstName, member.lastName].filter(Boolean).join(" ").trim() || "-";
}

function roleLabel(role: string): string {
    const map: Record<string, string> = {
        Owner: "Administrador del consignador",
        Staff: "Empleado de la tienda",
    };
    return map[role] ?? role;
}

function buildStoreRegistrationText(input: StoreRegistrationEmailInput): string {
    const members = input.members
        .map((member) => `- ${memberName(member)} | ${member.email} | ${roleLabel(member.role)}${member.phone ? ` | ${member.phone}` : ""}`)
        .join("\n");

    return [
        "Registro de consignador exitoso",
        "",
        `Tienda: ${input.storeName}`,
        `ID de la tienda: ${input.storeNumber}`,
        `Correo de la tienda: ${input.storeEmail}`,
        input.storePhone ? `Teléfono de la tienda: ${input.storePhone}` : "",
        `Estado actual: ${statusLabel(input.status)}`,
        "",
        "Miembros de la tienda con acceso al sistema:",
        members || "-",
        "",
        `Accede al Backoffice: ${process.env.BACKOFFICE_URL ?? "-"}`,
        "Usa la contraseña que estableciste durante el registro para iniciar sesión.",
        "",
        `Contacto: ${process.env.SUPPORT_EMAIL ?? process.env.MAIL_FROM_EMAIL ?? "-"}`,
    ].filter(Boolean).join("\n");
}

function buildStoreRegistrationHtml(input: StoreRegistrationEmailInput): string {
    const status = statusTheme(input.status);
    const members = input.members.map((member) => `
        <tr>
            <td style="padding:14px 16px;border-bottom:1px solid #e8edf3;color:#111827;font-weight:700;">${escapeHtml(memberName(member))}</td>
            <td style="padding:14px 16px;border-bottom:1px solid #e8edf3;color:#334155;">
                <a href="mailto:${escapeHtml(member.email)}" style="color:#1d4ed8;text-decoration:none;font-weight:600;">${escapeHtml(member.email)}</a>
            </td>
            <td style="padding:14px 16px;border-bottom:1px solid #e8edf3;color:#334155;">${escapeHtml(roleLabel(member.role))}</td>
            <td style="padding:14px 16px;border-bottom:1px solid #e8edf3;color:#334155;">${escapeHtml(member.phone || "-")}</td>
        </tr>
    `).join("");

    const backofficeUrl = process.env.BACKOFFICE_URL?.trim();
    const supportEmail = process.env.SUPPORT_EMAIL?.trim() || process.env.MAIL_FROM_EMAIL?.trim() || "-";

    return `
        <div style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,'Helvetica Neue',Tahoma,sans-serif;color:#111827;line-height:1.6;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;background:#f4f7fb;">
                <tr>
                    <td align="center" style="padding:32px 16px;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:720px;border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;box-shadow:0 18px 48px rgba(15,23,42,0.10);">
                            <tr>
                                <td style="padding:0;background:#0f172a;">
                                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                                        <tr>
                                            <td style="padding:28px 32px;background:linear-gradient(135deg,#0f172a 0%,#1e293b 52%,#314158 100%);">
                                                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                                                    <tr>
                                                        <td style="vertical-align:middle;">
                                                            <div style="display:inline-block;width:44px;height:44px;border-radius:6px;background:#ffffff;color:#0f172a;text-align:center;line-height:44px;font-weight:800;font-size:22px;margin-right:12px;">A</div>
                                                            <span style="color:#ffffff;font-size:22px;font-weight:800;vertical-align:middle;">Arcana</span>
                                                        </td>
                                                        <td align="right" style="vertical-align:middle;">
                                                            <span style="display:inline-block;padding:8px 12px;border-radius:6px;background:${status.background};border:1px solid ${status.border};color:${status.color};font-size:13px;font-weight:800;">
                                                                ${escapeHtml(statusLabel(input.status))}
                                                            </span>
                                                        </td>
                                                    </tr>
                                                </table>
                                                <h1 style="margin:28px 0 8px;color:#ffffff;font-size:28px;line-height:1.3;font-weight:800;">Registro de consignador exitoso</h1>
                                                <p style="margin:0;color:#dbeafe;font-size:15px;">Hemos recibido la información de tu tienda y continuaremos según el estado más reciente indicado abajo.</p>
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>

                            <tr>
                                <td style="padding:30px 32px 12px;">
                                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0;border:1px solid #e2e8f0;border-radius:8px;background:#ffffff;">
                                        <tr>
                                            <td style="padding:20px 22px;border-bottom:1px solid #edf2f7;">
                                                <div style="color:#64748b;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;">Store profile</div>
                                                <div style="margin-top:4px;color:#0f172a;font-size:24px;font-weight:800;line-height:1.35;">${escapeHtml(input.storeName)}</div>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding:18px 22px;">
                                                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                                                    <tr>
                                                        <td style="padding:8px 0;color:#64748b;font-size:13px;width:34%;">ID de la tienda</td>
                                                        <td style="padding:8px 0;color:#111827;font-size:14px;font-weight:700;">${escapeHtml(input.storeNumber)}</td>
                                                    </tr>
                                                    <tr>
                                                        <td style="padding:8px 0;color:#64748b;font-size:13px;">Correo de la tienda</td>
                                                        <td style="padding:8px 0;color:#111827;font-size:14px;font-weight:700;">
                                                            <a href="mailto:${escapeHtml(input.storeEmail)}" style="color:#1d4ed8;text-decoration:none;">${escapeHtml(input.storeEmail)}</a>
                                                        </td>
                                                    </tr>
                                                    ${input.storePhone ? `
                                                    <tr>
                                                        <td style="padding:8px 0;color:#64748b;font-size:13px;">Teléfono de la tienda</td>
                                                        <td style="padding:8px 0;color:#111827;font-size:14px;font-weight:700;">${escapeHtml(input.storePhone)}</td>
                                                    </tr>
                                                    ` : ""}
                                                    <tr>
                                                        <td style="padding:8px 0;color:#64748b;font-size:13px;">Estado actual</td>
                                                        <td style="padding:8px 0;color:${status.color};font-size:14px;font-weight:800;">${escapeHtml(statusLabel(input.status))}</td>
                                                    </tr>
                                                </table>
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>

                            <tr>
                                <td style="padding:18px 32px 8px;">
                                    <h2 style="margin:0 0 12px;color:#0f172a;font-size:18px;line-height:1.4;font-weight:800;">Miembros de la tienda con acceso al sistema</h2>
                                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:separate;border-spacing:0;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;background:#ffffff;">
                                        <thead>
                                            <tr style="background:#f8fafc;">
                                                <th align="left" style="padding:13px 16px;border-bottom:1px solid #e2e8f0;color:#475569;font-size:12px;font-weight:800;">Nombre</th>
                                                <th align="left" style="padding:13px 16px;border-bottom:1px solid #e2e8f0;color:#475569;font-size:12px;font-weight:800;">Correo electrónico</th>
                                                <th align="left" style="padding:13px 16px;border-bottom:1px solid #e2e8f0;color:#475569;font-size:12px;font-weight:800;">Rol</th>
                                                <th align="left" style="padding:13px 16px;border-bottom:1px solid #e2e8f0;color:#475569;font-size:12px;font-weight:800;">Teléfono</th>
                                            </tr>
                                        </thead>
                                        <tbody>${members || `<tr><td colspan="4" style="padding:16px;color:#64748b;">-</td></tr>`}</tbody>
                                    </table>
                                </td>
                            </tr>

                            <tr>
                                <td style="padding:22px 32px 32px;">
                                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
                                        <tr>
                                            <td style="padding:20px 22px;">
                                                <p style="margin:0 0 14px;color:#334155;font-size:14px;">Usa la contraseña que estableciste durante el registro para iniciar sesión en el Backoffice.</p>
                                                ${backofficeUrl ? `
                                                    <a href="${escapeHtml(backofficeUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;padding:12px 18px;font-size:14px;font-weight:800;">Acceder al Backoffice</a>
                                                    <p style="margin:12px 0 0;color:#64748b;font-size:12px;line-height:1.5;">URL: <a href="${escapeHtml(backofficeUrl)}" style="color:#1d4ed8;text-decoration:none;font-weight:700;">${escapeHtml(backofficeUrl)}</a></p>
                                                ` : `<p style="margin:0;color:#b91c1c;font-size:13px;font-weight:700;">Aún no se ha configurado BACKOFFICE_URL para el enlace de acceso.</p>`}
                                                <p style="margin:18px 0 0;color:#64748b;font-size:13px;">Si tienes alguna pregunta o necesitas corregir información, contáctanos en <a href="mailto:${escapeHtml(supportEmail)}" style="color:#1d4ed8;text-decoration:none;font-weight:700;">${escapeHtml(supportEmail)}</a></p>
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </div>
    `;
}

export async function sendStoreRegistrationEmail(input: StoreRegistrationEmailInput): Promise<void> {
    const recipients = uniqueEmails([input.storeEmail, ...input.members.map((member) => member.email)]);
    if (recipients.length === 0) {
        console.warn("[mailer] skipped: no store registration recipients");
        return;
    }

    await sendMail({
        to: recipients,
        subject: `Arcana: registro de la tienda ${input.storeName} exitoso`,
        text: buildStoreRegistrationText(input),
        html: buildStoreRegistrationHtml(input),
    });
}
