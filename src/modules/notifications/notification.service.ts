
import { pool } from "../../db/pool.js";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { mapPriorityToType, type NotificationDTO, type NotificationInput, type PlatformNotificationInput } from "./type.js";

import { getIO } from "../../socket/socket.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";

export async function ListNotification(st_id: number): Promise<NotificationDTO[]> {
    const [res] = await pool.query<RowDataPacket[] & NotificationDTO[]>(
        `SELECT * FROM Notifications
         WHERE target_type = 'STORE' AND target_id = ?
         ORDER BY noti_id DESC`,
        [st_id]
    )
    return res
    // return res.map(row => ({
    //     ...row,
    //     priority: mapPriorityToType(row.priority)
    // })) as NotificationDTO[]
}

export async function ListBuyerNotification(userId: number): Promise<NotificationDTO[]> {
    const [res] = await pool.query<RowDataPacket[] & NotificationDTO[]>(
        `SELECT * FROM Notifications
         WHERE target_type = 'USER' AND target_id = ?
         ORDER BY noti_id DESC`,
        [userId]
    );
    return res;
}

export async function getEmpBySTId(st_id: number): Promise<number[]> {
    const [res] = await pool.query<RowDataPacket[]>(`SELECT e_id FROM Employees WHERE st_id = ?`, [st_id])
    return res.map((row) => row.e_id)
}

export async function UpdateAsRead(noti_id: number): Promise<void> {
    const [res] = await pool.query<ResultSetHeader>(
        `UPDATE Notifications SET is_read = 1, read_at = ? WHERE noti_id = ?`,
        [new Date(), noti_id]
    );
    if (res.affectedRows === 0) throw new ApiError(404, CommonMessages.notFound);
}

export async function UpdateBuyerAsRead(noti_id: number, userId: number): Promise<void> {
    const [res] = await pool.query<ResultSetHeader>(
        `UPDATE Notifications SET is_read = 1, read_at = ?
         WHERE noti_id = ? AND target_type = 'USER' AND target_id = ?`,
        [new Date(), noti_id, userId]
    );
    if (res.affectedRows === 0) throw new ApiError(404, CommonMessages.notFound);
}

export async function UpdateAllRead(st_id: number): Promise<void> {
    await pool.query<ResultSetHeader>(
        `UPDATE Notifications
         SET is_read = 1, read_at = ?
         WHERE target_type = 'STORE' AND target_id = ? AND is_read = 0`,
        [new Date(), st_id]
    );
}

export async function UpdateBuyerAllRead(userId: number): Promise<void> {
    await pool.query<ResultSetHeader>(
        `UPDATE Notifications SET is_read = 1, read_at = ?
         WHERE target_type = 'USER' AND target_id = ? AND is_read = 0`,
        [new Date(), userId]
    );
}


export async function CreateNotification(input: NotificationInput): Promise<void> {
    const conn = await pool.getConnection();
    const notifications: Record<string, unknown>[] = [];
    try {
        await conn.beginTransaction();
        const MasterData = {
            target_type: input.target_type,
            target_id: input.target_id,
            type: input.type,
            title: input.title,
            message: input.message,
            action_url: input.action_url,
            ref_type: input.ref_type,
            ref_id: input.ref_id,
            priority: input.priority ?? "NORMAL",
        }
        const [result] = await conn.query<ResultSetHeader>("INSERT INTO Notifications SET ?", MasterData);
        notifications.push({
            noti_id: result.insertId,
            ...MasterData,
            is_read: 0,
            read_at: null,
            created_at: new Date(),
        });

        if (input.target_type === "STORE" && input.notifyPlatform) {
            const [platformStores] = await conn.query<(RowDataPacket & { st_id: number })[]>(
                "SELECT st_id FROM Store WHERE is_platform_store = 1"
            );

            for (const store of platformStores) {
                const platformStoreId = Number(store.st_id);
                if (!platformStoreId || platformStoreId === Number(input.target_id)) continue;

                const platformData = {
                    ...MasterData,
                    target_id: platformStoreId,
                };
                const [platformResult] = await conn.query<ResultSetHeader>(
                    "INSERT INTO Notifications SET ?",
                    platformData
                );
                notifications.push({
                    noti_id: platformResult.insertId,
                    ...platformData,
                    is_read: 0,
                    read_at: null,
                    created_at: new Date(),
                });
            }
        }

        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }

    for (const notification of notifications) {
        const roomName = `${notification.target_type}_${notification.target_id}`;
        getIO().to(roomName).emit("notification:new", notification);
    }
}

/** ส่งแจ้งเตือนให้เฉพาะ platform store (เจ้าของเว็บไซต์) โดยไม่แจ้ง store ต้นเรื่อง */
export async function NotifyPlatformStores(input: PlatformNotificationInput): Promise<void> {
    const conn = await pool.getConnection();
    const notifications: Record<string, unknown>[] = [];
    try {
        await conn.beginTransaction();
        const [platformStores] = await conn.query<(RowDataPacket & { st_id: number })[]>(
            "SELECT st_id FROM Store WHERE is_platform_store = 1"
        );

        for (const store of platformStores) {
            const platformStoreId = Number(store.st_id);
            if (!platformStoreId) continue;

            const platformData = {
                target_type: "STORE" as const,
                target_id: platformStoreId,
                type: input.type,
                title: input.title,
                message: input.message,
                action_url: input.action_url,
                ref_type: input.ref_type,
                ref_id: input.ref_id,
                priority: input.priority ?? "NORMAL",
            };
            const [platformResult] = await conn.query<ResultSetHeader>(
                "INSERT INTO Notifications SET ?",
                platformData
            );
            notifications.push({
                noti_id: platformResult.insertId,
                ...platformData,
                is_read: 0,
                read_at: null,
                created_at: new Date(),
            });
        }

        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }

    for (const notification of notifications) {
        const roomName = `${notification.target_type}_${notification.target_id}`;
        getIO().to(roomName).emit("notification:new", notification);
    }
}
