import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";

import type {
  CreateProductInput,
  ImageProductRow,
  OptionVariantDetailResponse,
  ProductDTO,
  ProductLanges,
  SubmitPayload,
  UpdateProductInput,
  VariantImageRow,
} from "./product.type.js";
import {
  ApiError,
  isDupError,
  isFkConstraintError,
} from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";

import { translateProductFields } from "../../shared/translate/translateProductFields.js";
import { translateLexicalContent } from "../../shared/utils/ImageSrc/translateLexicalContent.js";
import {
  deleteVariantImage,
  removePhysicalFile,
} from "../../shared/helper/deleteUploadFile.js";
import { fileUploadImage } from "../../shared/middlewares/fileUploadImage.js";
import { extractImageSrcsFromLexical } from "../../shared/utils/ฺBase64Image/Lexical/extractImageSrcsFromLexical.js";

export async function getProductName(
  p_code: string,
): Promise<ProductDTO | null> {
  const [rows] = await pool.query<RowDataPacket[] & ProductDTO[]>(
    `SELECT * FROM Products WHERE p_code = ?`,
    [p_code],
  );
  return rows[0] || null;
}

export async function getProductById(
  pl_id: number,
): Promise<ProductLanges | null> {
  const [rows] = await pool.query<RowDataPacket[] & ProductLanges[]>(
    `SELECT * FROM ProductLangs WHERE pl_id = ?`,
    [pl_id],
  );
  return rows[0] || null;
}

export async function getOtherDescriptionsByProductId(
  p_id: number,
  currentPlId: number,
): Promise<string[]> {
  const [rows] = await pool.query<
    (RowDataPacket & { p_description: string })[]
  >(`SELECT p_description FROM ProductLangs WHERE p_id = ? AND pl_id <> ?`, [
    p_id,
    currentPlId,
  ]);

  return rows.map((r) => r.p_description).filter(Boolean);
}

export async function getList(lg_code: string): Promise<ProductDTO[]> {
  const [rows] = await pool.query<RowDataPacket[] & ProductDTO[]>(
    `
        SELECT a.*,b.pl_id,c.ctl_description,c.ctl_name,f.e_firstname,b.lg_code,e.cl_name,h.b_name,g.ps_name,b.p_title,b.p_name,j.st_company_name,b.p_description,
            COALESCE(( SELECT JSON_ARRAYAGG(JSON_OBJECT(
                        'ip_id', ip.ip_id,
                        'images', ip.ip_image_url
                    )
                )
                FROM ImageProduct ip
                WHERE ip.p_id = a.p_id
            ), JSON_ARRAY()) AS images,
            COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT(
                        'ptag_id', pt.ptag_id,
                        'ptag_name', ptl.ptag_name
                    )
                )
                FROM ProductTagMaps pt
                INNER JOIN ProductTagLangs ptl
                    ON pt.ptag_id = ptl.ptag_id
                    AND ptl.lg_code = b.lg_code
                WHERE pt.p_id = a.p_id
            ), JSON_ARRAY()) AS ptag_id,
            (
                SELECT COUNT(*)
                FROM ProductVariants pv
                WHERE pv.p_id = a.p_id
            ) AS variant_count

        FROM Products a
        INNER JOIN ProductLangs b
        ON a.p_id = b.p_id
        INNER JOIN Catalog c
        ON c.ctl_id = a.ctl_id
        INNER JOIN Categorys d
        ON d.c_id = a.c_id
        INNER JOIN CategoryLangs e
        ON d.c_id = e.c_id and e.lg_code = b.lg_code
        INNER JOIN Employees f
        ON f.e_id = a.e_id 
        INNER JOIN ProductStatus g 
        ON g.ps_id = a.ps_id
        INNER JOIN Brands h 
        ON h.b_id = a.b_id 
        INNER JOIN Employees i 
        ON i.e_id = a.e_id
        INNER JOIN Store j
        ON j.st_id = i.st_id
        WHERE b.lg_code = ?
        ORDER BY a.p_id DESC`,
    [lg_code],
  );
  return rows;
}

async function generateProductCode(): Promise<string> {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    const now = new Date();
    const yyyymm =
      now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, "0");

    const prefix = `P${yyyymm}-`;
    const [rows]: any = await conn.query(
      `SELECT p_code FROM Products WHERE p_code LIKE ? ORDER BY p_code DESC LIMIT 1 FOR UPDATE`,
      [`${prefix}%`],
    );

    let nextNumber = 1;

    if (rows.length > 0 && rows[0].p_code) {
      const parts = rows[0].p_code.split("-");

      if (parts.length === 2) {
        const lastNumber = Number(parts[1]);
        if (Number.isFinite(lastNumber)) {
          nextNumber = lastNumber + 1;
        }
      }
    }

    const running = String(nextNumber).padStart(4, "0");
    const newCode = `${prefix}${running}`;

    await conn.commit();
    return newCode;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function createProduct(
  input: CreateProductInput,
): Promise<number> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // console.log(input.p_name);

    const shortFields = await translateProductFields([input.p_name]);

    const p_description = await translateLexicalContent(input.p_description);
    const p_code = await generateProductCode();

    const p_name = {
      es: shortFields.es[0] ?? "",
      en: shortFields.en[0] ?? "",
      ja: shortFields.ja[0] ?? "",
      th: shortFields.th[0] ?? "",
    };

    const masterData = {
      e_id: input.e_id,
      p_code: p_code,
      p_isActive: input.p_isActive,
      c_id: input.c_id,
      b_id: input.b_id,
      ctl_id: input.ctl_id,
      ps_id: input.ps_id,
      st_id: input.st_id,
      p_preorder_delivery_days: input.p_preorder_delivery_days,
    };
    const [masterRes] = await conn.query<ResultSetHeader>(
      "INSERT INTO Products SET ?",
      masterData,
    );

    const imageData = input.images.map((image) => [masterRes.insertId, image]);

    if (imageData.length > 0) {
      await conn.query(
        "INSERT INTO ImageProduct (p_id, ip_image_url) VALUES ?",
        [imageData],
      );
    }

    const productTagsData = input.ptag_id.map((tagId) => [
      masterRes.insertId,
      tagId,
    ]);

    if (productTagsData.length > 0) {
      await conn.query("INSERT INTO ProductTagMaps (p_id, ptag_id) VALUES ?", [
        productTagsData,
      ]);
    }

    const p_id = masterRes.insertId;
    const langRows = [
      [p_id, "es", p_name.es, p_description.es],
      [p_id, "en", p_name.en, p_description.en],
      [p_id, "ja", p_name.ja, p_description.ja],
      [p_id, "th", p_name.th, p_description.th],
    ];

    await conn.query(
      `INSERT INTO ProductLangs (p_id, lg_code,p_name, p_description) VALUES ?`,
      [langRows],
    );
    await conn.commit();
    return p_id;
  } catch (err) {
    await conn.rollback();
    if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
    throw err;
  } finally {
    await conn.release();
  }
}

export async function UpdateProducts(
  pl_id: number,
  input: UpdateProductInput,
  files: Express.Multer.File[] = [],
): Promise<void> {
  const conn = await pool.getConnection();

  // เก็บ path ของรูปใหม่ไว้ เผื่อ rollback แล้วต้องลบทิ้ง
  const uploadedPaths: string[] = [];

  try {
    await conn.beginTransaction();

    const [langRows]: any = await conn.query(
      "SELECT p_id FROM ProductLangs WHERE pl_id = ? LIMIT 1",
      [pl_id],
    );

    if (!langRows.length) {
      throw new ApiError(404, CommonMessages.notFound);
    }

    const p_id = langRows[0].p_id;

    // -----------------------------
    // 1) update tag map
    // -----------------------------
    const prdTagMaps = input.ptag_id.map((tagId) => [p_id, tagId]);

    await conn.query("DELETE FROM ProductTagMaps WHERE p_id = ?", [p_id]);

    if (prdTagMaps.length > 0) {
      await conn.query("INSERT INTO ProductTagMaps (p_id, ptag_id) VALUES ?", [
        prdTagMaps,
      ]);
    }

    // -----------------------------
    // 2) update ProductLangs
    // -----------------------------
    const masterDataProductlang = {
      p_name: input.p_name,
      p_description: input.p_description,
    };

    await conn.query<ResultSetHeader>(
      "UPDATE ProductLangs SET ? WHERE pl_id = ?",
      [masterDataProductlang, pl_id],
    );

    // -----------------------------
    // 3) update Products
    // -----------------------------
    const toDbBool = (value: unknown): 0 | 1 => {
      const v = String(value).trim().toLowerCase();

      return v === "true" || v === "1" || v === "yes" || v === "on" ? 1 : 0;
    };
    const masterDataProduct = {
      c_id: input.c_id,
      b_id: input.b_id,
      ctl_id: input.ctl_id,
      ps_id: input.ps_id,
      p_update_at: new Date(),
      p_isActive: toDbBool(input.p_isActive),
      p_preorder_delivery_days: input.p_preorder_delivery_days,
    };

    const [result] = await conn.query<ResultSetHeader>(
      "UPDATE Products SET ? WHERE p_id = ?",
      [masterDataProduct, p_id],
    );
    // console.log({
    //     raw: input.p_isAccept,
    //     type: typeof input.p_isAccept,
    //     convert: toDbBool(input.p_isAccept)
    // });
    // console.log("update result =>", {
    //     p_id,
    //     inputAccept: input.p_isAccept,
    //     saveAccept: masterDataProduct.p_isAccept,
    //     affectedRows: result.affectedRows,
    //     changedRows: result.changedRows,
    // });

    // -----------------------------
    // 4) ถ้ามีรูปใหม่ -> ลบรูปเก่า + insert รูปใหม่
    // -----------------------------
    if (files.length > 0) {
      // 4.1 ดึงรูปเก่าจาก DB
      const [oldImages] = await conn.query<ImageProductRow[] & RowDataPacket[]>(
        "SELECT ip_id, ip_image_url, is_primary, p_id FROM ImageProduct WHERE p_id = ?",
        [p_id],
      );

      // 4.2 ลบ record เก่าออกจาก DB ก่อน
      await conn.query("DELETE FROM ImageProduct WHERE p_id = ?", [p_id]);

      // 4.3 ลบไฟล์เก่าจริงในเครื่อง
      for (const oldImage of oldImages) {
        if (oldImage.ip_image_url) {
          removePhysicalFile(oldImage.ip_image_url);
        }
      }

      // 4.4 upload รูปใหม่ + insert DB
      for (const [index, file] of files.entries()) {
        const imagePath = await fileUploadImage(
          file,
          `product_${Date.now()}_${index}`,
          "products",
        );

        const normalizedPath = imagePath.replace(/\\/g, "/");
        uploadedPaths.push(normalizedPath);

        await conn.query<ResultSetHeader>(
          `INSERT INTO ImageProduct (ip_image_url, is_primary, p_id )
                     VALUES (?, ?, ?)`,
          [normalizedPath, index === 0 ? 1 : null, p_id],
        );
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    // ถ้า rollback แล้ว รูปใหม่ที่ upload ไปแล้วต้องลบทิ้ง
    for (const uploadedPath of uploadedPaths) {
      removePhysicalFile(uploadedPath);
    }
    if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
    throw err;
  } finally {
    conn.release();
  }
}

export async function getOptionVariant(
  p_id: number,
): Promise<OptionVariantDetailResponse | null> {
  const conn = await pool.getConnection();
  try {
    const [[productRow]] = await conn.query<RowDataPacket[]>(
      `SELECT p_id, e_id FROM Products WHERE p_id = ?`,
      [p_id],
    );

    if (!productRow) return null;

    const [optionItems] = await conn.query<RowDataPacket[]>(
      `SELECT 
            poi.poi_id,
            poi.potn_id,
            po.otype_id, 
            poi.poi_value
            FROM ProductOptions po
            INNER JOIN ProductOptionItems poi ON po.potn_id = poi.potn_id WHERE po.p_id = ?
            ORDER BY poi.poi_id ASC`,
      [p_id],
    );

    const [variants] = await conn.query<RowDataPacket[]>(
      `SELECT
            pv.pv_id,
            pv.pv_sku,
            pv.pv_cost,
            pv.pv_price,
            pv.discount,
            pv.weight_g,
            pv.length_cm,
            pv.width_cm,
            pv.height_cm,
            pv.is_default,
            pv.image_url,
            pv.unit_id
            FROM ProductVariants pv WHERE pv.p_id = ? ORDER BY pv.pv_id ASC`,
      [p_id],
    );

    const [variantOptionItems] = await conn.query<RowDataPacket[]>(
      `SELECT
            voi.pv_id,
            voi.poi_id
            FROM VariantOptionItems voi
            INNER JOIN ProductVariants pv ON pv.pv_id = voi.pv_id WHERE pv.p_id = ?
            ORDER BY voi.pv_id ASC, voi.poi_id ASC`,
      [p_id],
    );
    console.log(p_id);

    const [inventory] = await conn.query<RowDataPacket[]>(
      `SELECT
            i.inv_id,
            i.pv_id,
            i.loc_id,
            i.on_hand,
            i.reserved_qty
            FROM Inventorys i INNER JOIN ProductVariants pv ON pv.pv_id = i.pv_id
            WHERE pv.p_id = ?
            ORDER BY i.inv_id ASC`,
      [p_id],
    );

    return {
      p_id: Number(productRow.p_id),
      e_id: Number(productRow.e_id),
      optionItems: optionItems as OptionVariantDetailResponse["optionItems"],
      variants: variants as OptionVariantDetailResponse["variants"],
      variantOptionItems:
        variantOptionItems as OptionVariantDetailResponse["variantOptionItems"],
      inventory: inventory as OptionVariantDetailResponse["inventory"],
    };
  } finally {
    conn.release();
  }
}

export async function createOptionVariant(data: SubmitPayload): Promise<void> {
  const conn = await pool.getConnection();
  const filesToDelete: string[] = [];
  try {
    await conn.beginTransaction();

    const {
      p_id,
      optionItems,
      variants,
      variantOptionItems,
      inventory,
      e_id,
      st_id,
    } = data;

    if (!p_id) {
      throw new Error("p_id is required");
    }

    const poiIdMap: Record<number, number> = {};
    const pvIdMap: Record<number, number> = {};
    const potnIdMap: Record<number, number> = {}; // otype_id -> potn_id

    // =========================================================
    // 1) Sync ProductOptions
    // =========================================================

    const uniqueOptionTypeIds = [
      ...new Set(optionItems.map((item) => Number(item.otype_id))),
    ];

    const [existingOptionRows] = await conn.query<RowDataPacket[]>(
      `SELECT potn_id, otype_id FROM ProductOptions WHERE p_id = ?`,
      [p_id],
    );

    const existingOptionMap = new Map<number, number>(); // otype_id -> potn_id
    for (const row of existingOptionRows) {
      existingOptionMap.set(Number(row.otype_id), Number(row.potn_id));
    }

    const incomingOptionTypeSet = new Set(uniqueOptionTypeIds);

    // 1.1 keep old / insert new
    for (const otype_id of uniqueOptionTypeIds) {
      const existingPotnId = existingOptionMap.get(otype_id);

      if (existingPotnId) {
        potnIdMap[otype_id] = existingPotnId;
      } else {
        const [res] = await conn.query<ResultSetHeader>(
          `INSERT INTO ProductOptions (p_id, otype_id)  VALUES (?, ?)`,
          [p_id, otype_id],
        );

        potnIdMap[otype_id] = res.insertId;
      }
    }

    // =========================================================
    // 2) Sync ProductOptionItems + poiIdMap
    // =========================================================

    for (const [otype_id, potn_id] of Object.entries(potnIdMap)) {
      const numericOtypeId = Number(otype_id);

      const currentItems = optionItems.filter(
        (item) => Number(item.otype_id) === numericOtypeId,
      );

      const incomingValues = [
        ...new Set(currentItems.map((item) => item.poi_value.trim())),
      ];
      const incomingValueSet = new Set(incomingValues);

      const [existingPoiRows] = await conn.query<RowDataPacket[]>(
        `SELECT poi_id, poi_value FROM ProductOptionItems WHERE potn_id = ?`,
        [potn_id],
      );

      const existingPoiMap = new Map<string, number>(); // poi_value -> poi_id
      for (const row of existingPoiRows) {
        existingPoiMap.set(String(row.poi_value), Number(row.poi_id));
      }

      // 2.1 delete old poi that no longer exists in request
      // ต้องลบ VariantOptionItems ก่อน เพราะ FK อ้าง poi_id
      for (const [poi_value, poi_id] of existingPoiMap.entries()) {
        if (!incomingValueSet.has(poi_value)) {
          await conn.query(`DELETE FROM VariantOptionItems WHERE poi_id = ?`, [
            poi_id,
          ]);
          await conn.query(`DELETE FROM ProductOptionItems WHERE poi_id = ?`, [
            poi_id,
          ]);

          existingPoiMap.delete(poi_value);
        }
      }

      // 2.2 insert new poi
      for (const value of incomingValues) {
        if (!existingPoiMap.has(value)) {
          const [res] = await conn.query<ResultSetHeader>(
            `INSERT INTO ProductOptionItems (potn_id, poi_value) VALUES (?, ?)`,
            [potn_id, value],
          );

          existingPoiMap.set(value, res.insertId);
        }
      }

      // 2.3 rebuild poiIdMap ให้ตรงกับ temp poi_id/index ที่ frontend ส่งมา
      for (const [index, item] of optionItems.entries()) {
        if (Number(item.otype_id) === numericOtypeId) {
          const poiId = existingPoiMap.get(item.poi_value.trim());

          if (!poiId) {
            throw new Error(`poi_id not found for value=${item.poi_value}`);
          }
          const mapKey = item.poi_id ?? index + 1;
          poiIdMap[mapKey] = poiId;
        }
      }
    }

    // 2.4 delete ProductOptions that no longer exist in request
    // ลบหลังจาก sync option items เสร็จแล้ว เพื่อไม่ชน FK
    for (const [otype_id, potn_id] of existingOptionMap.entries()) {
      if (!incomingOptionTypeSet.has(otype_id)) {
        // ลบ mapping ก่อน
        await conn.query(
          `DELETE voi FROM VariantOptionItems voi
                     INNER JOIN ProductOptionItems poi ON poi.poi_id = voi.poi_id
                     WHERE poi.potn_id = ?`,
          [potn_id],
        );
        // ลบ option items
        await conn.query(`DELETE FROM ProductOptionItems WHERE potn_id = ?`, [
          potn_id,
        ]);

        // ลบ option
        await conn.query(`DELETE FROM ProductOptions  WHERE potn_id = ?`, [
          potn_id,
        ]);
      }
    }

    // =========================================================
    // 3) Sync ProductVariants
    // =========================================================

    const [existingVariantRows] = await conn.query<RowDataPacket[]>(
      `SELECT pv_id, pv_sku, image_url FROM ProductVariants  WHERE p_id = ?`,
      [p_id],
    );

    const existingVariantMap = new Map<
      string,
      { pv_id: number; image_url: string | null }
    >();

    for (const row of existingVariantRows) {
      existingVariantMap.set(String(row.pv_sku), {
        pv_id: Number(row.pv_id),
        image_url: row.image_url ? String(row.image_url) : null,
      });
    }

    const incomingSkuSet = new Set(variants.map((v) => v.pv_sku));

    // 3.1 delete variants removed by user
    // ต้องลบลูกก่อนตาม FK
    for (const [pv_sku, oldRow] of existingVariantMap.entries()) {
      if (!incomingSkuSet.has(pv_sku)) {
        await conn.query(`DELETE FROM Inventorys  WHERE pv_id = ?`, [
          oldRow.pv_id,
        ]);

        await conn.query(`DELETE FROM VariantOptionItems WHERE pv_id = ?`, [
          oldRow.pv_id,
        ]);

        await conn.query(`DELETE FROM ProductVariants  WHERE pv_id = ?`, [
          oldRow.pv_id,
        ]);

        if (oldRow.image_url) {
          filesToDelete.push(oldRow.image_url);
        }
      }
    }

    // 3.2 update existing / insert new
    for (const [index, v] of variants.entries()) {
      let pvId: number;

      const oldRow = existingVariantMap.get(v.pv_sku);

      if (oldRow) {
        pvId = oldRow.pv_id;
        const nextImageUrl =
          v.image_url && v.image_url !== oldRow.image_url
            ? v.image_url
            : oldRow.image_url;
        await conn.query(
          `UPDATE ProductVariants
                     SET pv_cost = ?,
                         pv_price = ?,
                         discount = ?,
                         weight_g = ?,
                         length_cm = ?,
                         width_cm = ?,
                         height_cm = ?,
                         is_default = ?,
                         image_url = ?,
                         unit_id = ?
                     WHERE pv_id = ?`,
          [
            v.pv_cost,
            v.pv_price,
            v.discount,
            v.weight_g,
            v.length_cm,
            v.width_cm,
            v.height_cm,
            v.is_default ? 1 : 0,
            nextImageUrl,
            v.unit_id ?? 1,
            pvId,
          ],
        );

        // ถ้ามีรูปใหม่มาแทนรูปเก่า ค่อย mark รูปเก่าไว้ลบ
        if (
          oldRow.image_url &&
          nextImageUrl &&
          oldRow.image_url !== nextImageUrl
        ) {
          filesToDelete.push(oldRow.image_url);
        }
      } else {
        const [res] = await conn.query<ResultSetHeader>(
          `INSERT INTO ProductVariants
                    (
                        p_id,
                        pv_sku,
                        pv_cost,
                        pv_price,
                        discount,
                        weight_g,
                        length_cm,
                        width_cm,
                        height_cm,
                        is_default,
                        image_url,
                        unit_id,
                        e_id,
                        st_id
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ,?)`,
          [
            p_id,
            v.pv_sku,
            v.pv_cost,
            v.pv_price,
            v.discount,
            v.weight_g,
            v.length_cm,
            v.width_cm,
            v.height_cm,
            v.is_default ? 1 : 0,
            v.image_url,
            v.unit_id ?? 1,
            e_id,
            st_id,
          ],
        );

        pvId = res.insertId;
      }

      const mapKey = v.pv_id ?? index + 1;
      pvIdMap[mapKey] = pvId;
    }

    // =========================================================
    // 4) Sync VariantOptionItems
    // =========================================================

    const incomingVariantOptionPairs = variantOptionItems.map((map) => {
      const realPvId = pvIdMap[map.pv_id];
      const realPoiId = poiIdMap[map.poi_id];

      if (!realPvId || !realPoiId) {
        throw new Error(
          `Invalid mapping: pv_id=${map.pv_id}, poi_id=${map.poi_id}`,
        );
      }

      return {
        pv_id: realPvId,
        poi_id: realPoiId,
        key: `${realPvId}_${realPoiId}`,
      };
    });

    const incomingPairSet = new Set(
      incomingVariantOptionPairs.map((x) => x.key),
    );

    const [existingVariantOptionRows] = await conn.query<RowDataPacket[]>(
      `SELECT voi.pv_id, voi.poi_id FROM VariantOptionItems voi 
            INNER JOIN ProductVariants pv ON pv.pv_id = voi.pv_id 
            WHERE pv.p_id = ?`,
      [p_id],
    );

    // 4.1 delete removed pairs
    for (const row of existingVariantOptionRows) {
      const key = `${Number(row.pv_id)}_${Number(row.poi_id)}`;

      if (!incomingPairSet.has(key)) {
        await conn.query(
          `DELETE FROM VariantOptionItems WHERE pv_id = ? AND poi_id = ?`,
          [row.pv_id, row.poi_id],
        );
      }
    }

    // 4.2 insert new pairs
    for (const item of incomingVariantOptionPairs) {
      const exists = existingVariantOptionRows.some(
        (row) =>
          Number(row.pv_id) === item.pv_id &&
          Number(row.poi_id) === item.poi_id,
      );

      if (!exists) {
        await conn.query(
          `INSERT INTO VariantOptionItems (pv_id, poi_id) VALUES (?, ?)`,
          [item.pv_id, item.poi_id],
        );
      }
    }

    // =========================================================
    // 5) Sync Inventorys
    // =========================================================

    const incomingInventories = inventory.map((inv) => {
      const realPvId = pvIdMap[inv.pv_id];

      if (!realPvId) {
        throw new Error(`Invalid inventory mapping: pv_id=${inv.pv_id}`);
      }

      return {
        pv_id: realPvId,
        loc_id: inv.loc_id,
        on_hand: inv.on_hand,
        reserved_qty: inv.reserved_qty,
        key: `${realPvId}_${inv.loc_id}`,
      };
    });

    const incomingInventoryKeySet = new Set(
      incomingInventories.map((x) => x.key),
    );

    const [existingInventoryRows] = await conn.query<RowDataPacket[]>(
      `SELECT i.inv_id, i.pv_id, i.loc_id FROM Inventorys i
             INNER JOIN ProductVariants pv ON pv.pv_id = i.pv_id WHERE pv.p_id = ?`,
      [p_id],
    );

    // 5.1 delete removed inventory rows
    for (const row of existingInventoryRows) {
      const key = `${Number(row.pv_id)}_${Number(row.loc_id)}`;

      if (!incomingInventoryKeySet.has(key)) {
        await conn.query(`DELETE FROM Inventorys  WHERE inv_id = ?`, [
          row.inv_id,
        ]);
      }
    }

    // 5.2 update existing / insert new
    for (const item of incomingInventories) {
      const found = existingInventoryRows.find(
        (row) =>
          Number(row.pv_id) === item.pv_id &&
          Number(row.loc_id) === item.loc_id,
      );

      if (found) {
        await conn.query(
          `UPDATE Inventorys  SET on_hand = ?, reserved_qty = ? WHERE inv_id = ?`,
          [item.on_hand, item.reserved_qty, found.inv_id],
        );
      } else {
        const [result] = await conn.query<ResultSetHeader>(
          `INSERT INTO Inventorys (pv_id, loc_id, on_hand, reserved_qty) VALUES (?, ?, ?, ?)`,
          [item.pv_id, item.loc_id, item.on_hand, item.reserved_qty],
        );
        const newInvId = result.insertId;
        await conn.query(
          `INSERT INTO InventoryLog(on_hand,ivnl_status,inv_id,pv_id,st_id,e_id) VALUES (?,?,?,?,?,?)`,
          [item.on_hand, "เพิ่ม", newInvId, item.pv_id, st_id, e_id],
        );
      }
    }

    const produtMaster = {
      p_update_at: new Date(),
    };

    await conn.query(`UPDATE Products SET ? WHERE p_id = ?`, [
      produtMaster,
      p_id,
    ]);

    await conn.commit();
    for (const filePath of filesToDelete) {
      deleteVariantImage(filePath);
    }
  } catch (error) {
    await conn.rollback();
    if (isDupError(error)) {
      throw new ApiError(409, CommonMessages.isExits);
    }
    throw error;
  } finally {
    conn.release();
  }
}

export async function deleteProduct(p_id: number): Promise<string[]> {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 1) ตรวจว่ามี product จริงไหม
    const [productRows] = await conn.query<RowDataPacket[]>(
      `SELECT p_id FROM Products WHERE p_id = ? LIMIT 1`,
      [p_id],
    );

    if (productRows.length === 0) {
      throw new ApiError(404, CommonMessages.notFound);
    }

    // 2) gather รูปทั้งหมดก่อนลบ
    const [productImages] = await conn.query<
      ImageProductRow[] & RowDataPacket[]
    >(`SELECT ip_id, ip_image_url  FROM ImageProduct  WHERE p_id = ?`, [p_id]);

    const [productLangs] = await conn.query<ProductLanges[] & RowDataPacket[]>(
      `SELECT pl_id, p_description FROM ProductLangs  WHERE p_id = ?`,
      [p_id],
    );

    const [variantImages] = await conn.query<
      VariantImageRow[] & RowDataPacket[]
    >(`SELECT pv_id, image_url FROM ProductVariants  WHERE p_id = ?`, [p_id]);

    const imagePaths: string[] = [
      ...productImages.map((img) => img.ip_image_url),
      ...(variantImages.map((v) => v.image_url).filter(Boolean) as string[]),
      ...productLangs.flatMap((lang) =>
        extractImageSrcsFromLexical(lang.p_description),
      ),
    ];

    // 3) ลบ table ลูกก่อน
    // หมายเหตุ: ปรับตาม schema จริงของคุณ

    // inventory ของ variant
    await conn.query(
      `DELETE inv FROM Inventorys inv
             INNER JOIN ProductVariants pv ON pv.pv_id = inv.pv_id
             WHERE pv.p_id = ?`,
      [p_id],
    );

    // mapping variant option
    await conn.query(
      `DELETE voi FROM VariantOptionItems voi
             INNER JOIN ProductVariants pv ON pv.pv_id = voi.pv_id
             WHERE pv.p_id = ?`,
      [p_id],
    );

    // variants
    await conn.query(`DELETE FROM ProductVariants WHERE p_id = ?`, [p_id]);

    // option items / option groups ของ product
    // ปรับชื่อตารางตามจริงของคุณ
    await conn.query(
      `DELETE poi FROM ProductOptionItems poi
             INNER JOIN ProductOptions po ON po.potn_id = poi.potn_id
             WHERE po.p_id = ?`,
      [p_id],
    );

    await conn.query(`DELETE FROM ProductOptions WHERE p_id = ?`, [p_id]);

    // รูปสินค้า
    await conn.query(`DELETE FROM ImageProduct  WHERE p_id = ?`, [p_id]);

    // tag map
    await conn.query(`DELETE FROM ProductTagMaps  WHERE p_id = ?`, [p_id]);

    // ภาษาของสินค้า
    await conn.query(`DELETE FROM ProductLangs WHERE p_id = ?`, [p_id]);

    // สุดท้าย product แม่
    await conn.query(`DELETE FROM Products  WHERE p_id = ?`, [p_id]);

    await conn.commit();

    // คืน path รูปออกไปให้ controller ไปค่อยลบไฟล์จริงหลัง commit
    return [...new Set(imagePaths)];
  } catch (err) {
    await conn.rollback();

    if (isFkConstraintError(err)) {
      throw new ApiError(409, CommonMessages.used);
    }

    throw err;
  } finally {
    conn.release();
  }
}
