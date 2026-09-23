import { isLocalUploadPath } from "../isBase64Image.js";
import { extractImageSrcsFromLexical } from "./extractImageSrcsFromLexical.js";

// 4) Encuentra solo las imágenes antiguas que deberían eliminarse (หาเฉพาะรูปเก่าที่ควรลบ)
export function getImagesToDelete(oldDescription: string, newDescription: string): string[] {
    const oldImages = extractImageSrcsFromLexical(oldDescription);
    const newImages = extractImageSrcsFromLexical(newDescription);

    const newImageSet = new Set(newImages);

    return oldImages.filter((oldSrc) => {
        // Solo se puede eliminar la imagen antigua si es una ruta local (ลบได้เฉพาะรูปเก่าที่เป็น local path)
        if (!isLocalUploadPath(oldSrc)) return false;

        // Si todavía está en los datos nuevos, significa que sigue en uso; no se debe eliminar (ถ้ายังมีอยู่ในข้อมูลใหม่ แปลว่ายังใช้อยู่ ห้ามลบ)
        if (newImageSet.has(oldSrc)) return false;

        // Si ya no está en los datos nuevos, entonces se elimina (ถ้าไม่มีในข้อมูลใหม่แล้ว ค่อยลบ)
        return true;
    });
}