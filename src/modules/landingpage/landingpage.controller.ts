import { CommonMessages } from "../../shared/messages/common.messages.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as landingpage from "./landingpage.service.js";
import { fileUploadImage } from "../../shared/middlewares/fileUploadImage.js";
import * as fs from "fs";
import * as pathfile from "path";
import { transformLexicalDescription } from "../../shared/utils/ฺBase64Image/transformLexicalDescription.js";
const apiBaseUrl = process.env.API_BASE_URL ?? "";

export const List = asyncHandler(async (req, res) => {
    const { st_id, lg_code } = req.params;
    const data = await landingpage.List(Number(st_id), String(lg_code));
    res.status(200).json({ data });
})

export const GetLandingPageProductId = asyncHandler(async (req, res) => {
    const { slug, lg_code } = req.params;

    const data = await landingpage.GetLandingPageProductId(String(slug), String(lg_code));
    res.status(200).json({ data });
})

export const CreateLandingPage = asyncHandler(async (req, res) => {
    const emptId = Number(req.empId);

    const rawData = req.body.data;
    const data = rawData ? JSON.parse(rawData) : req.body;

    data.e_id = emptId;
    data.st_id = Number(req.storeId);
    data.p_id = Number(data.p_id);

    const file = req.file;

    let lp_imagePath = null;

    const exits = await landingpage.GetLandingPageName(data.lp_slug);
    if (exits) {
        if (file) {
            fs.unlinkSync(file.path);
        }
        return res.status(400).json({ message: CommonMessages.isExits });
    }

    if (file) {
        const uploadedPath = await fileUploadImage(file, `ldp_${Date.now()}`, 'landingpage');
        if (uploadedPath) {
            lp_imagePath = uploadedPath.replace(/\\/g, '/');
        }
    }


    const transformedDescription = data.lp_description
        ? transformLexicalDescription(data.lp_description, apiBaseUrl)
        : data.lp_description;


    const result = await landingpage.CreateLandingPage({
        ...data,
        lp_imag_url: lp_imagePath,
        lp_description: transformedDescription,
    });

    res.status(201).json({
        message: CommonMessages.insertSuccess,
        data: result
    });
});

export const UpdateLandingPage = asyncHandler(async (req, res) => {
    const { lp_id } = req.params;
    const emptId = Number(req.empId);
    const rawData = req.body.data;
    const data = rawData ? JSON.parse(rawData) : req.body;
    const file = req.file;
    const oldImage = await landingpage.GetLandingPageById(Number(lp_id)).then(lp => lp?.lp_imag_url);
    let imagePath = oldImage; // เริ่มต้นด้วยภาพเก่า
    if (file) {
        if (oldImage) {
            const fullOldImagePath = pathfile.join(process.cwd(), 'uploads', oldImage);
            try {
                await fs.unlinkSync(fullOldImagePath);
            } catch (err: any) {
                console.log("ลบรูปเก่าไม่ได้ (อาจไม่มีไฟล์):", err.message);
            }
        }
        const path = await fileUploadImage(file, `ldp_${Date.now()}`, 'landingpage');
        if (path) {
            imagePath = path.replace(/\\/g, '/');
        }
    }

    const transformedDescription = data.lp_description
        ? transformLexicalDescription(data.lp_description, apiBaseUrl)
        : data.lp_description;

    const result = await landingpage.UpdateLandingPage({
        ...data,
        lp_id,
        lp_imag_url: imagePath,
        lp_description: transformedDescription,
        e_id: emptId
    });
    res.status(200).json({ message: CommonMessages.updateSuccess, data: result });

})

export const DeleteLandingPage = asyncHandler(async (req, res) => {
    const { group_id } = req.params;
    const data = await landingpage.GetLandingPageByGroupId(Number(group_id));
    if (!data) {
        return res.status(404).json({ message: CommonMessages.notFound });
    }
    const oldImage = data.lp_imag_url;
    if (oldImage) {
        const fullOldImagePath = pathfile.join(process.cwd(), 'public', oldImage);
        try {
            await fs.unlinkSync(fullOldImagePath);
        } catch (err: any) {
            console.log("ลบรูปเก่าไม่ได้ (อาจไม่มีไฟล์):", err.message);
        }
    }
    await landingpage.DeleteLandingPage(Number(group_id));
    res.status(200).json({ message: CommonMessages.deleteSuccess });

})

export const GetUniqueSlug = asyncHandler(async (req, res) => {
    const { slug } = req.params;
    const data = await landingpage.generateUniqueSlug(slug as string);
    // console.log("input slug:", slug);
    res.status(200).json({ data });
})

export const GetLandingPagesluge = asyncHandler(async (req, res) => {
    const data = await landingpage.GetLandingPagesluge();
    res.status(200).json({ data });
})
