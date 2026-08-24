import fs from "fs";
import path from "path";

// export async function fileUploadImage(file: any, keys: string, folder: string) {
//     const currentDate = new Date();
//     const year = currentDate.getFullYear();
//     const month = String(currentDate.getMonth() + 1).padStart(2, "0");
//     // const day = String(currentDate.getDate()).padStart(2, "0");
//     const uploadPath = `uploads/${folder}/${year}/${month}`;
//     const folderPatch = path.join(process.cwd(), "public", uploadPath);
//     const fileName = `${keys}${path.extname(file.originalname)}`;
//     const filePath = path.join(folderPatch, fileName);
//     fs.mkdirSync(folderPatch, { recursive: true });
//     fs.renameSync(file.path, filePath);

//     return `${uploadPath}/${fileName}`;
// }

export async function fileUploadImage(
    file: Express.Multer.File,
    keys: string,
    folder: string
) {
    const currentDate = new Date();
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, "0");

    const uploadPath = `uploads/${folder}/${year}/${month}`;
    const folderPath = path.join(process.cwd(), "public", uploadPath);

    const ext = path.extname(file.originalname);
    const fileName = `${keys}${ext}`;
    const filePath = path.join(folderPath, fileName);

    fs.mkdirSync(folderPath, { recursive: true });

    if (file.buffer) {
        // memoryStorage
        fs.writeFileSync(filePath, file.buffer);
    } else if (file.path) {
        // diskStorage / dest
        fs.renameSync(file.path, filePath);
    } else {
        throw new Error("Invalid upload file: missing both buffer and path");
    }

    return `${uploadPath}/${fileName}`;
}


/**
 * ลบไฟล์ temp อย่างปลอดภัย
 */
export function safeUnlink(filePath: string) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.error("safeUnlink error:", error);
    }
}

/**
 * ลบไฟล์ temp หลายไฟล์
 */
export function cleanupTempFiles(files: Express.Multer.File[]) {
    files.forEach((file) => safeUnlink(file.path));
}

/**
 * ลบไฟล์ temp จาก req.files (multer fields)
 */
export function cleanupRequestFiles(
    files: { [fieldname: string]: Express.Multer.File[] } | undefined
) {
    if (!files) return;
    Object.values(files).forEach((fileArray) => {
        cleanupTempFiles(fileArray);
    });
}


export function cleanupSavedFiles(paths: string[]) {
    paths.forEach((filePath) => {
        const fullPath = path.join(process.cwd(), "public", filePath);

        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }
    });
}