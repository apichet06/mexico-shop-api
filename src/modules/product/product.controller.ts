import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as products from "./product.service.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { fileUploadImage } from "../../shared/middlewares/fileUploadImage.js";
import * as fs from "fs";
import { transformLexicalDescription } from "../../shared/utils/ฺBase64Image/transformLexicalDescription.js";
import { getImagesToDelete } from "../../shared/utils/ฺBase64Image/Lexical/getImagesToDelete.js";
import { deleteImageFiles } from "../../shared/utils/ฺBase64Image/Lexical/deleteImageFiles.js";
import { filterUnusedImages } from "../../shared/utils/ฺBase64Image/Lexical/filterUnusedImages.js";
import { deleteManyPhysicalFiles } from "../../shared/helper/deleteUploadFile.js";
import { ApiError } from "../../shared/errors/ApiError.js";

const apiBaseUrl = process.env.API_BASE_URL ?? "";

function parseFormBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseImageIds(value: unknown): number[] | undefined {
  if (value === undefined || value === null) return undefined;

  let rawValues: unknown = value;
  if (typeof value === "string") {
    try {
      rawValues = JSON.parse(value);
    } catch {
      rawValues = [value];
    }
  }

  const values = Array.isArray(rawValues) ? rawValues : [rawValues];
  const ids = values.map(Number);

  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new ApiError(400, "La lista de imágenes existentes no es válida");
  }

  return [...new Set(ids)];
}

export const list = asyncHandler(async (_req, res) => {
  const { lg_code } = _req.params;

  const data = await products.getList(String(lg_code));
  res.status(200).json({ data });
});

export const create = asyncHandler(async (req, res) => {
  const {
    p_name,
    p_description,
    c_id,
    b_id,
    ptag_id,
    ps_id,
    p_isActive,
    p_preorder_delivery_days,
  } = req.body;

  const files = (req.files as Express.Multer.File[]) ?? [];

  let images: string[] = [];
  const empId = Number(req.empId);
  const storeId = Number(req.storeId);

  const exists = await products.getProductName(p_name);

  if (exists) {
    if (files && files.length > 0) {
      for (const file of files) {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    }
    return res.status(400).json({ message: CommonMessages.isExits });
  }

  if (files && files.length > 0) {
    const uploadedPaths: string[] = [];

    for (const file of files) {
      const path = await fileUploadImage(
        file,
        `product_${Date.now()}`,
        "products",
      );
      if (path) {
        uploadedPaths.push(path.replace(/\\/g, "/"));
      }
    }

    images = uploadedPaths;
  }

  const transformedDescription = p_description
    ? transformLexicalDescription(p_description, apiBaseUrl)
    : p_description;

  const input = {
    p_name,
    p_description: transformedDescription,
    c_id: Number(c_id),
    b_id: Number(b_id),
    ptag_id,
    ps_id: Number(ps_id),
    p_isActive: parseFormBoolean(p_isActive, true),
    p_preorder_delivery_days: Number(p_preorder_delivery_days) || 0,
    images,
    e_id: empId,
    st_id: storeId,
  };

  const data = await products.createProduct(input);

  res.status(201).json({
    message: CommonMessages.insertSuccess,
    data,
  });
});

export const update = asyncHandler(async (req, res) => {
  const {
    p_name,
    p_description,
    c_id,
    b_id,
    ptag_id,
    ps_id,
    p_isActive,
    p_preorder_delivery_days,
    existing_image_ids,
  } = req.body;
  const pl_id = Number(req.params.pl_id);
  const emp_id = Number(req.empId);
  // const storeId = Number(req.storeId);

  const files = (req.files as Express.Multer.File[]) ?? [];

  const rows = await products.getProductById(pl_id);

  if (!rows) {
    return res.status(404).json({ message: CommonMessages.notFound });
  }

  const oldDescription = rows.p_description;

  const transformedDescription = p_description
    ? transformLexicalDescription(p_description, apiBaseUrl)
    : p_description;

  const imagesToDelete = getImagesToDelete(
    oldDescription,
    transformedDescription,
  );
  const existingImageIds = parseImageIds(existing_image_ids);

  const data = {
    p_name,
    p_description: transformedDescription,
    c_id,
    b_id,
    ptag_id,
    ps_id,
    e_id: emp_id,
    p_isActive: parseFormBoolean(p_isActive, true),
    p_preorder_delivery_days: Number(p_preorder_delivery_days) || 0,
    ...(existingImageIds !== undefined
      ? { existing_image_ids: existingImageIds }
      : {}),
  };

  await products.UpdateProducts(pl_id, data, files);
  const otherDescriptions = await products.getOtherDescriptionsByProductId(
    rows.p_id,
    pl_id,
  );
  const safeToDelete = filterUnusedImages(imagesToDelete, otherDescriptions);
  deleteImageFiles(safeToDelete);

  res.status(200).json({ message: CommonMessages.updateSuccess });
});

export const remove = asyncHandler(async (req, res) => {
  const p_id = Number(req.params.p_id);

  const imagePaths = await products.deleteProduct(p_id);

  await deleteManyPhysicalFiles(imagePaths);

  res.status(200).json({
    message: CommonMessages.deleteSuccess,
  });
});

export const createOptionVariant = asyncHandler(async (req, res) => {
  const emptId = Number(req.empId);
  const storeId = Number(req.storeId);

  const rawData = req.body.data;
  const data = rawData ? JSON.parse(rawData) : req.body;

  data.p_id = Number(req.params.p_id);
  data.e_id = emptId;
  data.st_id = storeId;

  const files = req.files as Express.Multer.File[] | undefined;

  const imagePvIds = Array.isArray(req.body.imagePvIds)
    ? req.body.imagePvIds
    : req.body.imagePvIds
      ? [req.body.imagePvIds]
      : [];

  if (files && files.length > 0) {
    for (const [index, file] of files.entries()) {
      const pvId = Number(imagePvIds[index]);

      const targetVariant = data.variants.find((v: any) => v.pv_id === pvId);
      if (targetVariant) {
        const path = await fileUploadImage(
          file,
          `variant_${Date.now()}_${index}`,
          "variants",
        );
        targetVariant.image_url = path.replace(/\\/g, "/");
      }
    }
  }

  const result = await products.createOptionVariant(data);
  res.status(201).json({ message: CommonMessages.insertSuccess, data: result });
});

export const getOptionVariant = asyncHandler(async (req, res) => {
  const p_id = Number(req.params.p_id);
  const data = await products.getOptionVariant(p_id);
  res.status(200).json({ data });
});
