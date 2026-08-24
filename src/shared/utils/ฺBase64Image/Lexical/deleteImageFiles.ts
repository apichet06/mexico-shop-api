import fs from "fs";
import path from "path";
import { isLocalUploadPath } from "../isBase64Image.js";
// 3) แปลง URL เป็น file path แล้วลบ
export function deleteImageFiles(imageUrls: string[]) {
    for (const url of imageUrls) {
        try {
            if (!isLocalUploadPath(url)) continue;

            const relativePath = url.split("/uploads/")[1];
            if (!relativePath) continue;

            const filePath = path.join(process.cwd(), "public", "uploads", relativePath);

            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                // console.log("Deleted:", filePath);
            }
        } catch (error) {
            console.error("deleteImageFiles error:", error);
        }
    }
}