import cron from "node-cron";
import { pool } from "../../db/pool.js";
import type { RowDataPacket } from "mysql2/promise";
import { adminExecuteTransfer } from "./orders.service.js";

// ป้องกันการ start job ซ้ำหากเรียก startAutoPayoutJob() มากกว่าหนึ่งครั้ง
let autoPayoutJobStarted = false;

/**
 * ดึงรายชื่อร้านที่เปิดการโอนอัตโนมัติและมี Omise Recipient ID พร้อมแล้ว
 */
async function getEligibleStores(): Promise<{ st_id: number; st_company_name: string | null }[]> {
    const [rows] = await pool.query<(RowDataPacket & { st_id: number; st_company_name: string | null })[]>(
        `SELECT st_id, st_company_name
         FROM Store
         WHERE payout_enabled = 1
           AND omise_recipient_id IS NOT NULL
           AND omise_recipient_id != ''`
    );
    return rows;
}

/**
 * รันการโอนเงินอัตโนมัติให้ร้านทุกร้านที่ eligible
 * - ถ้าร้านไหนไม่มียอดครบกำหนด → ข้ามไป (ไม่ถือว่า error)
 * - ถ้าร้านไหนโอนล้มเหลว → log error แล้วโอนร้านถัดไปต่อ
 */
async function runAutoPayoutJob(): Promise<void> {
    console.log("[payout-cron] เริ่มรันโอนเงินอัตโนมัติ...");

    let stores: { st_id: number; st_company_name: string | null }[];
    try {
        stores = await getEligibleStores();
    } catch (err) {
        console.error("[payout-cron] ดึงรายชื่อร้านไม่สำเร็จ:", err);
        return;
    }

    if (stores.length === 0) {
        console.log("[payout-cron] ไม่มีร้านที่เปิดโอนอัตโนมัติ");
        return;
    }

    console.log(`[payout-cron] พบ ${stores.length} ร้านที่ eligible`);

    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (const store of stores) {
        try {
            const result = await adminExecuteTransfer(store.st_id);
            // โอนสำเร็จ — แสดง transfer ID และยอดที่โอน (หน่วยสตางค์ → บาท)
            console.log(
                `[payout-cron] ✓ ${store.st_company_name || `Store #${store.st_id}`}` +
                ` → ${result.omise_transfer_id} ฿${(result.amount / 100).toFixed(2)}`
            );
            successCount++;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);

            // "ไม่มียอดที่ครบกำหนดจ่าย" ไม่ใช่ error จริง — ร้านนั้นแค่ยังไม่มียอดรอ
            if (message.includes("ไม่มียอดที่ครบกำหนดจ่าย") || message.includes("ยอดรวมน้อยกว่า")) {
                console.log(`[payout-cron] - ${store.st_company_name || `Store #${store.st_id}`}: ข้ามเพราะ ${message}`);
                skipCount++;
            } else {
                console.error(`[payout-cron] ✗ ${store.st_company_name || `Store #${store.st_id}`}: ${message}`);
                errorCount++;
            }
        }
    }

    console.log(
        `[payout-cron] เสร็จสิ้น — สำเร็จ: ${successCount}, ข้าม: ${skipCount}, ล้มเหลว: ${errorCount}`
    );
}

/**
 * เริ่ม cron job สำหรับโอนเงินอัตโนมัติ
 *
 * cronExpression — cron expression สำหรับกำหนดเวลารัน
 *   ค่า default: "0 2 * * *" = ทุกวันตอน 02:00 น.
 *   ตัวอย่างอื่น:
 *     "0 8 * * *"   = 08:00 น. ทุกวัน
 *     "0 2 * * 1"   = 02:00 น. ทุกวันจันทร์
 *     "0 2 1 * *"   = 02:00 น. วันที่ 1 ของทุกเดือน
 */
export function startAutoPayoutJob(cronExpression = "0 2 * * *"): void {
    // ป้องกัน start ซ้ำ
    if (autoPayoutJobStarted) return;
    autoPayoutJobStarted = true;

    if (!cron.validate(cronExpression)) {
        console.error(`[payout-cron] cron expression ไม่ถูกต้อง: "${cronExpression}"`);
        return;
    }

    cron.schedule(cronExpression, () => {
        // void เพื่อบอก TypeScript ว่าเราจงใจไม่ await ที่นี่
        // error handling อยู่ใน runAutoPayoutJob() แล้ว
        void runAutoPayoutJob();
    }, {
        // timezone ไทย — ทำให้ "0 2 * * *" หมายถึง 02:00 น. เวลาไทยจริงๆ
        timezone: "Asia/Bangkok",
    });

    console.log(`[payout-cron] Auto payout job เริ่มทำงานแล้ว (schedule: "${cronExpression}", timezone: Asia/Bangkok)`);
}
