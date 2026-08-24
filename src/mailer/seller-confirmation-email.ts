import type { SellerConfirmationEmailInput } from "./type.js";
import { sendMail } from "./mail-config.js";
import { escapeHtml } from "./mail-utils.js";

function buildText(input: SellerConfirmationEmailInput): string {
    return [
        "ยืนยันข้อมูลสมัครผู้ฝากขาย",
        "",
        `ร้าน: ${input.storeName}`,
        `ลิงก์ยืนยันข้อมูลและนโยบายความเป็นส่วนตัว: ${input.confirmUrl}`,
        `ลิงก์หมดอายุ: ${input.expiresAt.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}`,
        "",
        "กรุณาตรวจสอบข้อมูลร้านและกดยอมรับนโยบายความเป็นส่วนตัวด้วยตนเองก่อนระบบส่งร้านเข้าคิวตรวจสอบ",
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
                                    <h1 style="margin:24px 0 8px;font-size:26px;line-height:1.35;">ยืนยันข้อมูลสมัครผู้ฝากขาย</h1>
                                    <p style="margin:0;color:#dbeafe;font-size:15px;">แอดมินได้กรอกข้อมูลร้านเบื้องต้นให้แล้ว กรุณาตรวจสอบและยืนยันด้วยตนเอง</p>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding:30px 32px;">
                                    <p style="margin:0 0 8px;color:#64748b;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;">Store</p>
                                    <p style="margin:0 0 24px;color:#0f172a;font-size:24px;font-weight:800;">${escapeHtml(input.storeName)}</p>
                                    <p style="margin:0 0 20px;color:#334155;font-size:14px;">เพื่อความปลอดภัยและหลักฐานตาม PDPA กรุณาเปิดลิงก์ด้านล่างเพื่อตรวจสอบข้อมูลร้าน และกดยอมรับนโยบายความเป็นส่วนตัวด้วยตนเอง</p>
                                    <a href="${escapeHtml(input.confirmUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;padding:12px 18px;font-size:14px;font-weight:800;">ตรวจสอบและยืนยันข้อมูล</a>
                                    <p style="margin:14px 0 0;color:#64748b;font-size:12px;line-height:1.5;">URL: <a href="${escapeHtml(input.confirmUrl)}" style="color:#1d4ed8;text-decoration:none;font-weight:700;">${escapeHtml(input.confirmUrl)}</a></p>
                                    <p style="margin:16px 0 0;color:#64748b;font-size:13px;">ลิงก์หมดอายุ: ${escapeHtml(input.expiresAt.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }))}</p>
                                    <p style="margin:18px 0 0;color:#64748b;font-size:13px;">หากข้อมูลไม่ถูกต้อง กรุณาติดต่อ <a href="mailto:${escapeHtml(supportEmail)}" style="color:#1d4ed8;text-decoration:none;font-weight:700;">${escapeHtml(supportEmail)}</a></p>
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
        subject: `Arcana: กรุณายืนยันข้อมูลร้าน ${input.storeName}`,
        text: buildText(input),
        html: buildHtml(input),
    });
}
