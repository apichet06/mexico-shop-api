export type NotificationDTO = {
    noti_id?: number
    target_type: "USER" | "STORE"
    target_id: number

    type: string
    title: string
    message: string
    action_url: string | null
    ref_type: string | null
    ref_id: number | null
    is_read: 0 | 1
    read_at: Date | null
    priority: string
    created_at: Date
}
export type NotificationPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT"
export type NotificationInput = {
    target_type: "USER" | "STORE"
    target_id: number
    type: string
    title: string
    message: string
    action_url: string
    ref_type: string
    ref_id: number
    priority?: NotificationPriority
    /** Indica si también se debe enviar una copia de esta notificación a la store que es platform store (dueña del sitio) (ส่งสำเนาแจ้งเตือนนี้ไปให้ store ที่เป็น platform store (เจ้าของเว็บไซต์) ด้วยหรือไม่) */
    notifyPlatform?: boolean
}

export type PlatformNotificationInput = Omit<NotificationInput, "target_id">

export function mapPriorityToType(status: string) {
    // La etiqueta de nivel de prioridad de la campana usa español para coincidir con el texto que guarda la API (ป้ายระดับความสำคัญของกระดิ่งใช้ภาษาสเปนให้ตรงกับข้อความที่ API บันทึก)
    const map: Record<string, string> = {
        LOW: "Baja",
        NORMAL: "Normal",
        HIGH: "Alta",
        URGENT: "Urgente"
    }
    return map[status] ?? 'NORMAL'
}
