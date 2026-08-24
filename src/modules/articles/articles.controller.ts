import * as fs from "fs";
import * as pathfile from "path";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { fileUploadImage } from "../../shared/middlewares/fileUploadImage.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { transformLexicalDescription } from "../../shared/utils/ฺBase64Image/transformLexicalDescription.js";
import * as articles from "./articles.service.js";

const apiBaseUrl = process.env.API_BASE_URL ?? "";

export const list = asyncHandler(async (req, res) => {
    const { st_id, lg_code } = req.params;
    const data = await articles.list(Number(st_id), String(lg_code));
    res.status(200).json({ data });
});

export const publicList = asyncHandler(async (req, res) => {
    const { lg_code } = req.params;
    const st_id = req.query.st_id ? Number(req.query.st_id) : undefined;
    const homeOnly = req.query.homeOnly === "true" || req.query.homeOnly === "1";
    const data = await articles.publicList(String(lg_code), st_id, homeOnly);
    res.status(200).json({ data });
});

export const getBySlug = asyncHandler(async (req, res) => {
    const { slug, lg_code } = req.params;
    const data = await articles.getBySlug(String(slug), String(lg_code));
    res.status(200).json({ data });
});

export const create = asyncHandler(async (req, res) => {
    const rawData = req.body.data;
    const data = rawData ? JSON.parse(rawData) : req.body;
    const file = req.file;

    data.e_id = Number(req.empId);
    data.st_id = Number(req.storeId);

    let imagePath = null;

    if (file) {
        const uploadedPath = await fileUploadImage(file, `article_${Date.now()}`, "articles");
        if (uploadedPath) imagePath = uploadedPath.replace(/\\/g, "/");
    }

    const transformedContent = data.art_content
        ? transformLexicalDescription(data.art_content, apiBaseUrl)
        : data.art_content;

    const result = await articles.create({
        ...data,
        art_image_url: imagePath,
        art_content: transformedContent,
    });

    res.status(201).json({ message: CommonMessages.insertSuccess, data: result });
});

export const update = asyncHandler(async (req, res) => {
    const { art_id } = req.params;
    const rawData = req.body.data;
    const data = rawData ? JSON.parse(rawData) : req.body;
    const file = req.file;

    const oldArticle = await articles.getById(Number(art_id));
    let imagePath = oldArticle?.art_image_url ?? null;

    if (file) {
        if (imagePath) {
            const fullOldImagePath = pathfile.join(process.cwd(), "public", imagePath);
            try {
                fs.unlinkSync(fullOldImagePath);
            } catch (err: any) {
                console.log("ลบรูปเก่าไม่ได้ (อาจไม่มีไฟล์):", err.message);
            }
        }

        const uploadedPath = await fileUploadImage(file, `article_${Date.now()}`, "articles");
        if (uploadedPath) imagePath = uploadedPath.replace(/\\/g, "/");
    }

    const transformedContent = data.art_content
        ? transformLexicalDescription(data.art_content, apiBaseUrl)
        : data.art_content;

    const result = await articles.update({
        ...data,
        art_id: Number(art_id),
        art_image_url: imagePath,
        art_content: transformedContent,
        e_id: Number(req.empId),
    });

    res.status(200).json({ message: CommonMessages.updateSuccess, data: result });
});

export const remove = asyncHandler(async (req, res) => {
    const { group_id } = req.params;
    const data = await articles.getByGroupId(Number(group_id));

    if (!data) {
        return res.status(404).json({ message: CommonMessages.notFound });
    }

    if (data.art_image_url) {
        const fullOldImagePath = pathfile.join(process.cwd(), "public", data.art_image_url);
        try {
            fs.unlinkSync(fullOldImagePath);
        } catch (err: any) {
            console.log("ลบรูปเก่าไม่ได้ (อาจไม่มีไฟล์):", err.message);
        }
    }

    await articles.remove(Number(group_id));
    res.status(200).json({ message: CommonMessages.deleteSuccess });
});

export const getUniqueSlug = asyncHandler(async (req, res) => {
    const { slug } = req.params;
    const data = await articles.generateUniqueSlug(String(slug));
    res.status(200).json({ data });
});
