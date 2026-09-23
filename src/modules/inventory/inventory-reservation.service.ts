import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import { ApiError } from "../../shared/errors/ApiError.js";

type InventoryRow = RowDataPacket & {
    inv_id: number;
    pv_id: number;
    on_hand: number;
    reserved_qty: number;
};

export type InventoryReservationItem = {
    or_id: number;
    oi_id: number;
    pv_id: number;
    qty: number;
    order_no?: string;
};

let reservationTableReady: Promise<void> | null = null;

// Prepara la tabla ledger para vincular la reserva de stock con order/item (เตรียมตาราง ledger สำหรับผูกการจอง stock เข้ากับ order/item)
// Se crea de forma lazy en el primer checkout/payment, para que el sistema existente siga funcionando aunque no haya una migración separada (ทำแบบ lazy ตอนมี checkout/payment ครั้งแรก เพื่อให้ระบบเดิมรันต่อได้แม้ยังไม่มี migration แยก)
// Esta tabla no reemplaza a Inventorys.reserved_qty, sino que se usa como evidencia de a qué order pertenece cada parte del reserved_qty (ตารางนี้ไม่ได้แทน Inventorys.reserved_qty แต่ใช้เป็นหลักฐานว่า reserved_qty แต่ละส่วนเป็นของ order ไหน)
export function ensureInventoryReservationTable(): Promise<void> {
    reservationTableReady ??= pool.query(`
        CREATE TABLE IF NOT EXISTS Order_inventory_reservations (
            oir_id INT NOT NULL AUTO_INCREMENT,
            or_id INT NOT NULL,
            oi_id INT NOT NULL,
            inv_id INT NOT NULL,
            pv_id INT NOT NULL,
            qty_reserved INT NOT NULL DEFAULT 0,
            qty_consumed INT NOT NULL DEFAULT 0,
            status ENUM('reserved', 'consumed', 'released') NOT NULL DEFAULT 'reserved',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            consumed_at DATETIME NULL,
            released_at DATETIME NULL,
            PRIMARY KEY (oir_id),
            KEY idx_order_inventory_res_order (or_id, status),
            KEY idx_order_inventory_res_item (oi_id),
            KEY idx_order_inventory_res_inventory (inv_id, pv_id)
        )
    `).then(() => undefined);

    return reservationTableReady;
}

function assertPositiveQty(qty: number, label: string): number {
    const amount = Number(qty);
    if (!Number.isInteger(amount) || amount <= 0) {
        throw new ApiError(400, `${label}: la cantidad de producto no es válida.`); // `${label} จำนวนสินค้าไม่ถูกต้อง`
    }
    return amount;
}

// Reserva el stock para un order pending, incrementando Inventorys.reserved_qty y registrando de qué inv_id proviene la reserva de este order (จอง stock ให้ order pending โดยเพิ่ม Inventorys.reserved_qty และบันทึกว่า order นี้จองจาก inv_id ไหน)
// Si el available_qty no es suficiente, se lanza un throw para hacer rollback de toda la transaction del checkout (ถ้า available_qty ไม่พอจะ throw เพื่อ rollback checkout ทั้ง transaction)
export async function reserveInventoryForOrderItems(
    conn: PoolConnection,
    items: InventoryReservationItem[]
): Promise<void> {
    for (const item of items) {
        let need = assertPositiveQty(item.qty, item.order_no ?? `order ${item.or_id}`);

        // Bloquea el stock de esta variant hasta el final de la transaction, para evitar que varios checkouts compitan por el stock al mismo tiempo (lock stock ของ variant นี้จนจบ transaction เพื่อกันหลาย checkout แย่ง stock พร้อมกัน)
        const [rows] = await conn.query<InventoryRow[]>(
            `SELECT inv_id, pv_id, on_hand, reserved_qty
             FROM Inventorys
             WHERE pv_id = ?
             ORDER BY inv_id ASC
             FOR UPDATE`,
            [item.pv_id]
        );

        const availableTotal = rows.reduce((sum, row) => {
            return sum + Math.max(Number(row.on_hand) - Number(row.reserved_qty), 0);
        }, 0);

        if (availableTotal < need) {
            throw new ApiError(
                409,
                `El producto ${item.order_no ?? item.pv_id} no tiene suficiente cantidad disponible; solo quedan ${availableTotal} piezas disponibles para comprar.` // `สินค้า ${item.order_no ?? item.pv_id} มีจำนวนไม่พอ เหลือให้ซื้อได้ ${availableTotal} ชิ้น`
            );
        }

        for (const row of rows) {
            if (need <= 0) break;

            const availableInRow = Math.max(Number(row.on_hand) - Number(row.reserved_qty), 0);
            const reserveQty = Math.min(need, availableInRow);
            if (reserveQty <= 0) continue;

            await conn.query(
                `UPDATE Inventorys
                 SET reserved_qty = reserved_qty + ?
                 WHERE inv_id = ?`,
                [reserveQty, row.inv_id]
            );

            await conn.query<ResultSetHeader>(
                `INSERT INTO Order_inventory_reservations
                    (or_id, oi_id, inv_id, pv_id, qty_reserved, status, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`,
                [item.or_id, item.oi_id, row.inv_id, item.pv_id, reserveQty, new Date(), new Date()]
            );

            need -= reserveQty;
        }
    }
}

// Devuelve el stock que había sido reservado para el order, regresándolo al available_qty (คืน stock ที่เคยจองไว้ให้ order กลับมาเป็น available_qty)
// Se usa cuando el order se cancela o expira el tiempo de pago, sin tocar on_hand porque el producto nunca salió del almacén (ใช้ตอน order ถูกยกเลิกหรือหมดเวลาชำระเงิน โดยไม่แตะ on_hand เพราะของยังไม่เคยออกจากคลัง)
export async function releaseReservationsForOrders(
    conn: PoolConnection,
    orderIds: number[]
): Promise<void> {
    if (orderIds.length === 0) return;

    const [reservations] = await conn.query<(RowDataPacket & {
        oir_id: number;
        inv_id: number;
        qty_reserved: number;
        qty_consumed: number;
    })[]>(
        `SELECT oir_id, inv_id, qty_reserved, qty_consumed
         FROM Order_inventory_reservations
         WHERE or_id IN (?) AND status = 'reserved'
         ORDER BY oir_id ASC
         FOR UPDATE`,
        [orderIds]
    );

    for (const reservation of reservations) {
        const releaseQty = Number(reservation.qty_reserved) - Number(reservation.qty_consumed);
        if (releaseQty <= 0) continue;

        // Devuelve el derecho de venta al available_qty, reduciendo reserved_qty solo en la parte correspondiente a este order (คืนสิทธิ์การขายกลับเข้า available_qty โดยลด reserved_qty เฉพาะส่วนของ order นี้)
        await conn.query(
            `UPDATE Inventorys
             SET reserved_qty = GREATEST(reserved_qty - ?, 0)
             WHERE inv_id = ?`,
            [releaseQty, reservation.inv_id]
        );
    }

    await conn.query(
        `UPDATE Order_inventory_reservations
         SET status = 'released', released_at = ?, updated_at = ?
         WHERE or_id IN (?) AND status = 'reserved'`,
        [new Date(), new Date(), orderIds]
    );
}

// Convierte el stock reservado en una venta real (แปลง stock ที่จองไว้เป็นยอดขายจริง)
// Se usa solo después de que payment está paid: reduce on_hand y reduce el reserved_qty de ese order en el ledger (ใช้หลัง payment paid เท่านั้น: ลด on_hand และลด reserved_qty ของ order นั้นออกจาก ledger)
export async function consumeReservationsForOrders(
    conn: PoolConnection,
    orderIds: number[]
): Promise<void> {
    if (orderIds.length === 0) return;

    const [reservations] = await conn.query<(RowDataPacket & {
        oir_id: number;
        inv_id: number;
        qty_reserved: number;
        qty_consumed: number;
    })[]>(
        `SELECT oir_id, inv_id, qty_reserved, qty_consumed
         FROM Order_inventory_reservations
         WHERE or_id IN (?) AND status = 'reserved'
         ORDER BY oir_id ASC
         FOR UPDATE`,
        [orderIds]
    );

    for (const reservation of reservations) {
        const consumeQty = Number(reservation.qty_reserved) - Number(reservation.qty_consumed);
        if (consumeQty <= 0) continue;

        // El pago ya se completó con éxito, así que se descuenta el stock real: se reducen on_hand y reserved_qty al mismo tiempo (จ่ายสำเร็จแล้วจึงตัด stock จริง: ลดทั้ง on_hand และ reserved_qty พร้อมกัน)
        const [result] = await conn.query<ResultSetHeader>(
            `UPDATE Inventorys
             SET on_hand = on_hand - ?,
                 reserved_qty = GREATEST(reserved_qty - ?, 0)
             WHERE inv_id = ?
               AND on_hand >= ?
               AND reserved_qty >= ?`,
            [consumeQty, consumeQty, reservation.inv_id, consumeQty, consumeQty]
        );

        if (result.affectedRows === 0) {
            throw new ApiError(409, "No hay suficiente cantidad de producto en el inventario para descontar el stock después del pago."); // "จำนวนสินค้าในคลังไม่พอสำหรับตัดยอดหลังชำระเงิน"
        }

        await conn.query(
            `UPDATE Order_inventory_reservations
             SET qty_consumed = qty_reserved,
                 status = 'consumed',
                 consumed_at = ?,
                 updated_at = ?
             WHERE oir_id = ?`,
            [new Date(), new Date(), reservation.oir_id]
        );
    }
}

// Devuelve el stock real al almacén después de que un order ya pagado recibe un refund exitoso (คืน stock จริงกลับเข้าคลังหลัง order ที่จ่ายเงินแล้วได้รับ refund สำเร็จ)
// Se basa principalmente en el consumed ledger, para que la devolución ocurra solo una vez y no se duplique el stock si el endpoint se llama repetidamente (ใช้ consumed ledger เป็นหลักเพื่อให้คืนได้ครั้งเดียวและไม่เพิ่ม stock ซ้ำหาก endpoint ถูกเรียกซ้ำ)
export async function restockConsumedReservationsForOrders(
    conn: PoolConnection,
    orderIds: number[]
): Promise<void> {
    if (orderIds.length === 0) return;

    const [reservations] = await conn.query<(RowDataPacket & {
        oir_id: number;
        inv_id: number;
        qty_consumed: number;
    })[]>(
        `SELECT oir_id, inv_id, qty_consumed
         FROM Order_inventory_reservations
         WHERE or_id IN (?) AND status = 'consumed'
         ORDER BY oir_id ASC
         FOR UPDATE`,
        [orderIds]
    );

    for (const reservation of reservations) {
        const restockQty = Number(reservation.qty_consumed);
        if (restockQty <= 0) continue;

        await conn.query(
            `UPDATE Inventorys
             SET on_hand = on_hand + ?
             WHERE inv_id = ?`,
            [restockQty, reservation.inv_id]
        );
    }

    await conn.query(
        `UPDATE Order_inventory_reservations
         SET status = 'released', released_at = ?, updated_at = ?
         WHERE or_id IN (?) AND status = 'consumed'`,
        [new Date(), new Date(), orderIds]
    );
}

let reservationRestockColumnReady: Promise<void> | null = null;

// Prepara la column qty_restocked para contar por separado cuánto stock ya se devolvió de cada fila de reservation (เตรียม column qty_restocked ไว้แยกนับว่า reservation แต่ละแถวถูกคืนสต็อกไปแล้วเท่าไหร่)
// Es necesaria para devoluciones parciales dentro del mismo oi_id (por ejemplo, comprar 2 y devolver solo 1) (จำเป็นสำหรับการคืนสินค้าแค่บางจำนวนใน oi_id เดียวกัน (เช่น ซื้อ 2 คืนแค่ 1))
export function ensureReservationRestockColumn(): Promise<void> {
    reservationRestockColumnReady ??= pool.query<(RowDataPacket & { column_name: string })[]>(
        `SELECT COLUMN_NAME AS column_name
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'Order_inventory_reservations'
           AND COLUMN_NAME = 'qty_restocked'`
    )
        .then(async ([columns]) => {
            if (columns.length === 0) {
                await pool.query(
                    "ALTER TABLE Order_inventory_reservations ADD COLUMN qty_restocked INT NOT NULL DEFAULT 0 AFTER qty_consumed"
                );
            }
        })
        .then(() => undefined);

    return reservationRestockColumnReady;
}

// Igual que restockConsumedReservationsForOrders, pero devuelve el stock según la cantidad indicada por oi_id (no todo); se usa para devoluciones parciales de algunos items/cantidades (เหมือน restockConsumedReservationsForOrders แต่คืนสต็อกตามจำนวนที่ระบุต่อ oi_id (ไม่ใช่ทั้งชิ้น) ใช้กับการคืนสินค้าบางรายการ/บางจำนวน)
// itemQtyMap: oi_id -> la cantidad de stock que se desea devolver; puede estar repartida en varias filas de reservation (varios lotes de stock) para el mismo oi_id, por lo que hay que recorrer fila por fila hasta completar la cantidad (itemQtyMap: oi_id -> จำนวนที่ต้องการคืนสต็อก อาจกระจายอยู่หลาย reservation row (หลาย lot สต็อก) ต่อ oi_id เดียว จึงต้องไล่คืนทีละแถวจนครบจำนวน)
export async function restockConsumedReservationsForItems(
    conn: PoolConnection,
    or_id: number,
    itemQtyMap: Map<number, number>
): Promise<void> {
    await ensureReservationRestockColumn();

    const oiIds = [...itemQtyMap.keys()];
    if (oiIds.length === 0) return;

    const [reservations] = await conn.query<(RowDataPacket & {
        oir_id: number;
        oi_id: number;
        inv_id: number;
        qty_consumed: number;
        qty_restocked: number;
    })[]>(
        `SELECT oir_id, oi_id, inv_id, qty_consumed, qty_restocked
         FROM Order_inventory_reservations
         WHERE or_id = ? AND oi_id IN (?) AND status = 'consumed'
         ORDER BY oir_id ASC
         FOR UPDATE`,
        [or_id, oiIds]
    );

    const remainingByOiId = new Map(itemQtyMap);

    for (const reservation of reservations) {
        const remaining = remainingByOiId.get(Number(reservation.oi_id)) ?? 0;
        if (remaining <= 0) continue;

        const available = Number(reservation.qty_consumed) - Number(reservation.qty_restocked);
        const restockQty = Math.min(remaining, available);
        if (restockQty <= 0) continue;

        await conn.query(
            `UPDATE Inventorys
             SET on_hand = on_hand + ?
             WHERE inv_id = ?`,
            [restockQty, reservation.inv_id]
        );

        const newQtyRestocked = Number(reservation.qty_restocked) + restockQty;
        const fullyRestocked = newQtyRestocked >= Number(reservation.qty_consumed);

        await conn.query(
            `UPDATE Order_inventory_reservations
             SET qty_restocked = ?,
                 status = ?,
                 released_at = ?,
                 updated_at = ?
             WHERE oir_id = ?`,
            [newQtyRestocked, fullyRestocked ? "released" : "consumed", fullyRestocked ? new Date() : null, new Date(), reservation.oir_id]
        );

        remainingByOiId.set(Number(reservation.oi_id), remaining - restockQty);
    }
}
