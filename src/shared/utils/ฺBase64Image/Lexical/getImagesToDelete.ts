import { isLocalUploadPath } from "../isBase64Image.js";
import { extractImageSrcsFromLexical } from "./extractImageSrcsFromLexical.js";

// 4) หาเฉพาะรูปเก่าที่ควรลบ
export function getImagesToDelete(oldDescription: string, newDescription: string): string[] {
    const oldImages = extractImageSrcsFromLexical(oldDescription);
    const newImages = extractImageSrcsFromLexical(newDescription);

    const newImageSet = new Set(newImages);

    return oldImages.filter((oldSrc) => {
        // ลบได้เฉพาะรูปเก่าที่เป็น local path
        if (!isLocalUploadPath(oldSrc)) return false;

        // ถ้ายังมีอยู่ในข้อมูลใหม่ แปลว่ายังใช้อยู่ ห้ามลบ
        if (newImageSet.has(oldSrc)) return false;

        // ถ้าไม่มีในข้อมูลใหม่แล้ว ค่อยลบ
        return true;
    });
}