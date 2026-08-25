export const MAIN_WAREHOUSE_NAME = "Main Warehouse";

// ชื่อคลังที่ API สร้างอัตโนมัติใช้ภาษาอังกฤษเป็นค่ากลางเพียงภาษาเดียว
export function getSubWarehouseName(sequence: number): string {
    return `Sub Warehouse ${sequence}`;
}
