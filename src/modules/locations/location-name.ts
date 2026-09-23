export const MAIN_WAREHOUSE_NAME = "Main Warehouse";

// El nombre del almacén que la API genera automáticamente usa el inglés como único valor estándar (ชื่อคลังที่ API สร้างอัตโนมัติใช้ภาษาอังกฤษเป็นค่ากลางเพียงภาษาเดียว)
export function getSubWarehouseName(sequence: number): string {
    return `Sub Warehouse ${sequence}`;
}
