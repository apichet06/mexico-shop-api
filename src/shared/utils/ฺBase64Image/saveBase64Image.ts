import fs from "fs";
import path from "path";
import crypto from "crypto";

type SaveBase64ImageOptions = {
    base64: string;
    folderName?: string;
    apiBaseUrl: string;
};

type SaveBase64ImageResult = {
    filename: string;
    relativePath: string;
    fullUrl: string;
};

export function saveBase64Image({
    base64,
    folderName = "editor",
    apiBaseUrl,
}: SaveBase64ImageOptions): SaveBase64ImageResult {
    const match = base64.match(/^data:(image\/([a-zA-Z0-9.+-]+));base64,(.+)$/);

    if (!match) {
        throw new Error("Invalid base64 image format");
    }

    const extRaw = match[2];
    const data = match[3];

    if (!extRaw || !data) {
        throw new Error("Invalid base64 image data");
    }

    const ext = extRaw === "jpeg" ? "jpg" : extRaw;
    const buffer = Buffer.from(data, "base64");

    const filename = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const uploadDir = path.join(process.cwd(), "public", "uploads", folderName);
    const filePath = path.join(uploadDir, filename);

    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
    }

    fs.writeFileSync(filePath, buffer);

    const relativePath = `/uploads/${folderName}/${filename}`;

    return {
        filename,
        relativePath,
        fullUrl: `${apiBaseUrl}${relativePath}`,
    };
}
