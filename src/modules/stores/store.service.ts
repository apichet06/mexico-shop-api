import type { ResultSetHeader, RowDataPacket } from "mysql2";
import crypto from "crypto";
import { pool } from "../../db/pool.js";
import {
  mapDocumetType,
  mapStatusToAction,
  mapStatusToType,
  type BankDTO,
  type CreateStoreRegisterInput,
  type StoreDetailDTO,
  type StoreDocumentBackend,
  type StoreDTO,
  type StoreLogDTO,
  type StoreShopDTO,
  type StoreTaxProfileDTO,
  type UpdateStoreInput,
} from "./store.type.js";
import {
  ApiError,
  isDupError,
  isFkConstraintError,
} from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/index.js";
import type { empDTO } from "../employees/emp.type.js";
import * as notiService from "../notifications/notification.service.js";
import type { NotificationInput } from "../notifications/type.js";
import type { StoreRegistrationEmailInput } from "../../mailer/type.js";
import { getSubWarehouseName, MAIN_WAREHOUSE_NAME } from "../locations/location-name.js";

const SELLER_CONFIRMATION_TOKEN_EXPIRES_DAYS = 14;
const STORE_EMAIL_VERIFICATION_TOKEN_EXPIRES_DAYS = 7;

function hashSellerConfirmationToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function ensureSellerConfirmationTable(): Promise<void> {
  await pool.query(`
        CREATE TABLE IF NOT EXISTS Store_Seller_Confirmation_Tokens (
            sct_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            st_id INT NOT NULL,
            token_hash VARCHAR(64) NOT NULL,
            expires_at DATETIME NOT NULL,
            used_at DATETIME NULL,
            created_by_emp_id INT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            confirmed_at DATETIME NULL,
            confirmed_ip VARCHAR(64) NULL,
            confirmed_user_agent VARCHAR(255) NULL,
            pdpa_notice_version VARCHAR(100) NULL,
            PRIMARY KEY (sct_id),
            UNIQUE KEY uq_store_seller_confirmation_token_hash (token_hash),
            KEY idx_store_seller_confirmation_st_id (st_id),
            KEY idx_store_seller_confirmation_expires_at (expires_at)
        )
    `);
}

function hashStoreEmailVerificationToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function ensureStoreEmailVerificationTable(): Promise<void> {
  await pool.query(`
        CREATE TABLE IF NOT EXISTS Store_Email_Verification_Tokens (
            sevt_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            st_id INT NOT NULL,
            email VARCHAR(100) NOT NULL,
            token_hash VARCHAR(64) NOT NULL,
            expires_at DATETIME NOT NULL,
            used_at DATETIME NULL,
            created_by_emp_id INT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            confirmed_at DATETIME NULL,
            confirmed_ip VARCHAR(64) NULL,
            confirmed_user_agent VARCHAR(255) NULL,
            PRIMARY KEY (sevt_id),
            UNIQUE KEY uq_store_email_verification_token_hash (token_hash),
            KEY idx_store_email_verification_st_id_email (st_id, email),
            KEY idx_store_email_verification_expires_at (expires_at)
        )
    `);
}

async function ensureEmployeeEmailVerificationTable(): Promise<void> {
  await pool.query(`
        CREATE TABLE IF NOT EXISTS Employee_Email_Verification_Tokens (
            eevt_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            e_id INT NOT NULL,
            email VARCHAR(100) NOT NULL,
            token_hash VARCHAR(64) NOT NULL,
            expires_at DATETIME NOT NULL,
            confirmed_at DATETIME NULL,
            used_at DATETIME NULL,
            requires_password_setup TINYINT(1) NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            request_ip VARCHAR(64) NULL,
            user_agent VARCHAR(255) NULL,
            PRIMARY KEY (eevt_id),
            UNIQUE KEY uq_employee_email_verification_token_hash (token_hash),
            KEY idx_employee_email_verification_e_id (e_id),
            KEY idx_employee_email_verification_email (email),
            KEY idx_employee_email_verification_expires_at (expires_at)
        )
    `);
  try {
    await pool.query(`
            ALTER TABLE Employee_Email_Verification_Tokens
            ADD COLUMN requires_password_setup TINYINT(1) NOT NULL DEFAULT 0 AFTER used_at
        `);
  } catch (err) {
    if ((err as { code?: string }).code !== "ER_DUP_FIELDNAME") {
      throw err;
    }
  }
}

async function ensureEmployeePasswordResetTable(): Promise<void> {
  await pool.query(`
        CREATE TABLE IF NOT EXISTS Employee_Password_Reset_Tokens (
            prt_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            e_id INT NOT NULL,
            token_hash VARCHAR(64) NOT NULL,
            expires_at DATETIME NOT NULL,
            used_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            request_ip VARCHAR(64) NULL,
            user_agent VARCHAR(255) NULL,
            PRIMARY KEY (prt_id),
            UNIQUE KEY uq_employee_password_reset_token_hash (token_hash),
            KEY idx_employee_password_reset_e_id (e_id),
            KEY idx_employee_password_reset_expires_at (expires_at)
        )
    `);
}

async function isPlatformStore(st_id: number): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT is_platform_store FROM Store WHERE st_id = ? LIMIT 1`,
    [st_id],
  );
  const value = rows[0]?.is_platform_store;

  return value === true || value === 1 || value === "1";
}

export async function listStores(): Promise<StoreDTO[]> {
  const [rows] = await pool.query<RowDataPacket[] & StoreDTO[]>(`
        SELECT a.*, b.bk_name FROM Store a LEFT JOIN Bank b ON a.bk_id = b.bk_id order by a.st_id asc`);
  return rows;
}

export async function getlistStoreShop(): Promise<StoreShopDTO[]> {
  const [rows] = await pool.query<RowDataPacket[] & StoreShopDTO[]>(
    `SELECT st_id, st_company_name, st_phone, st_image, st_email  FROM Store`,
  );
  return rows;
}

export async function getlistSroreShopById(st_id: number) {
  const [rows] = await pool.query<RowDataPacket[] & StoreShopDTO[]>(
    `SELECT st_id, st_company_name, st_phone, st_image, st_email  FROM Store WHERE st_id = ?`,
    [st_id],
  );
  return rows[0] || null;
}

export async function getStoreById(
  st_id: number,
): Promise<StoreDetailDTO | null> {
  // 1. ตรวจว่ามีร้านนี้จริงก่อน — ถ้าไม่มี return null เลย ไม่ต้อง query ต่อ

  await ensureStoreEmailVerificationTable();

  const [storeRows] = await pool.query<RowDataPacket[] & StoreDTO[]>(
    `SELECT a.*, b.bk_name,
                (
                    SELECT MAX(sevt.confirmed_at)
                    FROM Store_Email_Verification_Tokens sevt
                    WHERE sevt.st_id = a.st_id
                      AND sevt.email = a.st_email
                      AND sevt.confirmed_at IS NOT NULL
                ) AS st_email_verified_at
         FROM Store a
         LEFT JOIN Bank b ON a.bk_id = b.bk_id
         WHERE a.st_id = ?`,
    [st_id],
  );

  const store = storeRows[0];
  if (!store) return null;

  return {
    store,
    tax: null,
    documents: [],
  };
}

export async function getStoreRegistrationEmailInput(
  st_id: number,
): Promise<StoreRegistrationEmailInput | null> {
  const [storeRows] = await pool.query<
    (RowDataPacket & {
      st_id: number;
      st_number: string;
      st_company_name: string;
      st_email: string;
      st_phone: string | null;
      st_status: string;
    })[]
  >(
    `SELECT st_id, st_number, st_company_name, st_email, st_phone, st_status
         FROM Store
         WHERE st_id = ?
         LIMIT 1`,
    [st_id],
  );
  const storeRow = storeRows[0];
  if (!storeRow) return null;

  const [employeeRows] = await pool.query<
    (RowDataPacket & {
      e_firstname: string | null;
      e_lastname: string | null;
      e_email: string;
      e_phone: string | null;
      e_status: string;
    })[]
  >(
    `SELECT e_firstname, e_lastname, e_email, e_phone, e_status
         FROM Employees
         WHERE st_id = ?
         ORDER BY e_status = 'Owner' DESC, e_id ASC`,
    [st_id],
  );

  return {
    storeId: storeRow.st_id,
    storeNumber: storeRow.st_number,
    storeName: storeRow.st_company_name,
    storeEmail: storeRow.st_email,
    storePhone: storeRow.st_phone,
    status: storeRow.st_status,
    members: employeeRows.map((employee) => ({
      firstName: employee.e_firstname,
      lastName: employee.e_lastname,
      email: employee.e_email,
      phone: employee.e_phone,
      role: employee.e_status,
    })),
  };
}

export async function getStoreByCompanyName(
  st_data: string,
): Promise<StoreDTO | null> {
  const [rows] = await pool.query<RowDataPacket[] & StoreDTO[]>(
    `
        SELECT st_id, st_company_name, bank_account_number,
         st_email, created_at, st_phone, st_image FROM Store
          WHERE st_company_name = ? Or st_email = ? `,
    [st_data, st_data],
  );
  return rows[0] || null;
}

export async function getStoreByExactCompanyName(
  stCompanyName: string,
): Promise<StoreDTO | null> {
  const [rows] = await pool.query<RowDataPacket[] & StoreDTO[]>(
    `SELECT st_id, st_company_name, st_email FROM Store WHERE st_company_name = ? LIMIT 1`,
    [stCompanyName],
  );
  return rows[0] || null;
}

export async function getStoreByEmail(
  st_email: string,
): Promise<StoreDTO | null> {
  const [rows] = await pool.query<RowDataPacket[] & StoreDTO[]>(
    `SELECT st_id, st_company_name, st_email FROM Store WHERE st_email = ?`,
    [st_email],
  );
  return rows[0] || null;
}

export async function getEmployeeByEmail(
  e_email: string,
): Promise<String | null> {
  const [rows] = await pool.query<RowDataPacket[] & String[]>(
    `
        SELECT e_email FROM Employees WHERE e_email = ?`,
    [e_email],
  );
  return rows[0] || null;
}

export async function generateMaxStoreId(): Promise<string> {
  try {
    const year = new Date().getFullYear();
    const [result] = await pool.query<RowDataPacket[]>(
      "SELECT MAX(st_number) as maxId FROM Store",
    );
    const currentMaxId = result[0]?.maxId;

    let idNumber: number;
    if (!currentMaxId) {
      idNumber = 10001; // ยังไม่มี store เริ่มที่ 10001
    } else {
      idNumber = parseInt(currentMaxId.slice(8)) + 1;
    }
    return `ST-${year}-${idNumber.toString().padStart(5, "0")}`;
  } catch (error) {
    throw error;
  }
}

export async function getDocumentById(
  doc_id: number,
): Promise<{ file_path: string } | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT file_path FROM Store_Documents WHERE doc_id = ?`,
    [doc_id],
  );
  return (rows[0] as { file_path: string }) || null;
}

export async function getlistLogstore(st_id: number): Promise<StoreLogDTO[]> {
  const [rows] = await pool.query<RowDataPacket[] & StoreLogDTO[]>(
    `SELECT  * From Store_Logs WHERE st_id = ? Order by stl_timestamp desc`,
    [st_id],
  );
  return rows;
}

export async function requestDocument(
  st_id: number,
  eData: empDTO,
  note: string,
  doc_types: string[],
): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const docLabel = doc_types.map(mapDocumetType).join(", ");
    const logData = {
      st_id,
      stl_type: mapStatusToType("REQUEST"),
      stl_actor: eData.e_status + " " + eData.e_firstname,
      stl_action: mapStatusToAction("REQUEST_MORE"),
      stl_node: note + " - Se requieren los siguientes documentos adicionales: " + docLabel,
      stl_timestamp: new Date(),
    };

    await conn.query<ResultSetHeader>(`INSERT INTO Store_Logs SET ?`, [
      logData,
    ]);
    await conn.query<ResultSetHeader>(
      `UPDATE Store SET st_note = ?,st_status = ? , updated_at = ?
              WHERE st_id = ?`,
      [
        note + " - Se requieren los siguientes documentos adicionales: " + docLabel,
        "REQUEST",
        new Date(),
        st_id,
      ],
    );

    const notiData: NotificationInput = {
      target_type: "STORE",
      target_id: st_id,
      type: "REQUEST_MORE",
      title: "Documentos adicionales",
      message: `Se requieren los siguientes documentos adicionales: ${docLabel}`,
      action_url: "/dashboard/myShop",
      ref_type: "STORE",
      ref_id: st_id,
      priority: "HIGH",
    };

    await notiService.CreateNotification(notiData);

    await conn.commit();
  } catch {
    await conn.rollback();
  } finally {
    conn.release();
  }
}

export async function updateStoreStatus(
  st_id: number,
  input: { st_status: string; note: string },
  eData: empDTO,
): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { st_status, note } = input;
    const [currentRows] = await conn.query<
      (RowDataPacket & { st_status: string })[]
    >(`SELECT st_status FROM Store WHERE st_id = ? LIMIT 1 FOR UPDATE`, [
      st_id,
    ]);
    const current = currentRows[0];
    if (!current) {
      throw new ApiError(404, CommonMessages.notFound);
    }
    if (
      current.st_status === "PENDING_SELLER_CONFIRMATION" &&
      !["REJECTED", "SUSPENDED"].includes(st_status)
    ) {
      throw new ApiError(
        400,
        "Esta tienda aún espera que el vendedor confirme sus datos y acepte el aviso de privacidad (PDPA) mediante el enlace de invitación.",
      );
    }

    const [res] = await conn.query<ResultSetHeader>(
      `UPDATE Store SET st_status = ? ,st_note = ?, updated_at = ? WHERE st_id = ?`,
      [st_status, note, new Date(), st_id],
    );

    if (res.affectedRows === 0) {
      throw new ApiError(404, CommonMessages.notFound);
    }
    await conn.commit();

    const logData = {
      st_id,
      stl_type: mapStatusToType(st_status),
      stl_actor: eData.e_status + " " + eData.e_firstname,
      stl_action: mapStatusToAction(st_status),
      stl_node: note ?? null,
      stl_timestamp: new Date(),
    };

    await conn.query<ResultSetHeader>(`INSERT INTO Store_Logs SET ?`, [
      logData,
    ]);
    const notiData: NotificationInput = {
      target_type: "STORE",
      target_id: st_id,
      type: "STATUS_STORE",
      title: "Estado de la tienda actualizado",
      message: `${mapStatusToAction(st_status)}${note ? `: ${note}` : ""}`,
      action_url: "/dashboard/myShop",
      ref_type: "STORE",
      ref_id: st_id,
      priority: "HIGH",
    };

    await notiService.CreateNotification(notiData);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function DeleteDocumentFile(doc_id: number) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM Store_Documents WHERE doc_id = ?`, [doc_id]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function UploadDocumetDATA(
  documents: StoreDocumentBackend[],
  stId: number,
  eData: empDTO,
) {
  const conn = await pool.getConnection();
  try {
    if (documents && documents.length > 0) {
      const documentValues: any[] = [];

      for (const doc of documents) {
        if (doc.files && doc.files.length > 0) {
          doc.files.forEach((f: any) => {
            documentValues.push([
              stId,
              null,
              doc.doc_type,
              f.original_name,
              f.file_path,
              f.mime_type,
              f.size,
              1,
            ]);
          });
        }
      }

      if (documentValues.length > 0) {
        await conn.query(
          `INSERT INTO Store_Documents (st_id, tax_id, doc_type, file_name, file_path, file_mime, file_size, is_active)
             VALUES ?`,
          [documentValues],
        );
      }
    }
    const docLabel = documents
      .map((d) => mapDocumetType(d.doc_type))
      .join(", ");
    const logData = {
      st_id: stId,
      stl_type: mapStatusToType("UPLOAD"),
      stl_actor: eData.e_status + " " + eData.e_firstname,
      stl_action: mapStatusToAction("UPLOAD"),
      stl_node: "Enviado - " + docLabel,
      stl_timestamp: new Date(),
    };

    await conn.query<ResultSetHeader>(`INSERT INTO Store_Logs SET ?`, [
      logData,
    ]);

    await conn.query<ResultSetHeader>(
      `UPDATE Store SET st_status = ? , updated_at = ? WHERE st_id = ?`,
      ["UPLOAD", new Date(), stId],
    );

    await notiService.NotifyPlatformStores({
      target_type: "STORE",
      type: "NEW_STORE",
      title: "Documentos recibidos",
      message: `Se enviaron los siguientes documentos para revisión: ${docLabel}`,
      action_url: "/dashboard/store/dataStore/?st_id=" + stId,
      ref_type: "STORE",
      ref_id: stId,
    });

    await conn.commit();
  } catch (error) {
    conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function updateStoreTaxProfile(
  st_id: number,
  input: StoreTaxProfileDTO,
): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(`UPDATE Store_Tax_Profile SET ? WHERE st_id = ?`, [
      input,
      st_id,
    ]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function createStoreRegister(
  input: CreateStoreRegisterInput,
  eData?: empDTO,
): Promise<number> {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    const existingStoreName = await getStoreByExactCompanyName(
      input.st_company_name,
    );
    if (existingStoreName) {
      throw new ApiError(
        409,
        `El nombre de la tienda del consignador ${input.st_company_name} ya está en uso. Elige un nombre diferente.`,
      );
    }

    const existingStoreEmail = await getStoreByEmail(input.st_email);
    if (existingStoreEmail) {
      throw new ApiError(
        409,
        `El correo electrónico de la tienda del consignador ${input.st_email} ya está en uso. Usa otro correo electrónico.`,
      );
    }

    const requiresSellerConfirmation = Boolean(
      input.requires_seller_confirmation,
    );
    const employeeEmails = Array.from(
      new Set(
        input.employees.map((emp) => emp.e_email?.trim()).filter(Boolean),
      ),
    );
    for (const email of employeeEmails) {
      const existingEmployeeEmail = await getEmployeeByEmail(email);
      if (existingEmployeeEmail) {
        throw new ApiError(
          409,
          `El correo electrónico del administrador de la tienda ${email} ya está en uso. Usa otro correo electrónico.`,
        );
      }
    }

    if (
      input.employees.some((emp) => !["Owner", "Staff"].includes(emp.e_status))
    ) {
      throw new ApiError(
        400,
        "El usuario de la tienda debe ser únicamente administrador del consignador o empleado de la tienda.",
      );
    }
    if (!input.employees.some((emp) => emp.e_status === "Owner")) {
      throw new ApiError(400, "La tienda debe tener al menos un administrador del consignador.");
    }
    if (
      requiresSellerConfirmation &&
      (input.employees.length !== 1 || input.employees[0]?.e_status !== "Owner")
    ) {
      throw new ApiError(
        400,
        "La creación de una tienda por un administrador debe especificar únicamente un Primary Owner.",
      );
    }

    const st_id = input.st_id; // ได้มาจาก token
    const createdByPlatformStore = await isPlatformStore(st_id);
    const initialStatus = requiresSellerConfirmation
      ? "PENDING_SELLER_CONFIRMATION"
      : createdByPlatformStore
        ? "ACTIVE"
        : "PENDING";

    // ===== 1. Insert ตาราง stores (ตารางหลัก) =====
    const maxId = await generateMaxStoreId();
    const storeData = {
      st_number: maxId,
      st_company_name: input.st_company_name,
      bank_account_number: input.bank_account_number,
      st_email: input.st_email,
      st_phone: input.st_phone,
      st_image: input.st_image,
      bk_id: input.bk_id,
      st_status: initialStatus,
      is_platform_store: input.is_platform_store ?? false,
    };

    const [storeRes] = await conn.query<ResultSetHeader>(
      `INSERT INTO Store SET ?`,
      storeData,
    );
    const stId = storeRes.insertId;

    // ===== 2. Insert ตาราง store_locations =====
    if (input.locations.length > 0) {
      const defaultLocationIndex = input.locations.findIndex((loc) =>
        Boolean(loc.is_default),
      );
      const normalizedDefaultIndex =
        defaultLocationIndex >= 0 ? defaultLocationIndex : 0;
      let warehouseCount = 1;
      const locationValues = input.locations.map((loc, index) => {
        const isDefault = index === normalizedDefaultIndex;
        const locName = isDefault ? MAIN_WAREHOUSE_NAME : getSubWarehouseName(warehouseCount++);

        return [
          stId,
          locName,
          loc.loc_address,
          loc.loc_province_id,
          loc.loc_district_id,
          loc.loc_subdistrict_id,
          loc.loc_zip_code,
          isDefault,
        ];
      });

      await conn.query(
        `INSERT INTO Locations  (st_id, loc_name, loc_address, Provinces_id, Districts_id, Subdistricts_id, zip_code, is_default)VALUES ?`,
        [locationValues],
      );
    }

    const e_isActive = requiresSellerConfirmation ? false : true; // admin-assisted stores must be confirmed by seller first

    // ===== 3. Insert ตาราง store_employees =====
    if (input.employees.length > 0) {
      const employeeValues = input.employees.map((emp) => [
        stId,
        emp.e_firstname,
        emp.e_lastname,
        emp.e_email,
        emp.e_phone,
        emp.e_status,
        e_isActive,
        emp.e_password,
      ]);

      await conn.query(
        `INSERT INTO Employees 
                 (st_id, e_firstname, e_lastname, e_email, e_phone, e_status, e_isActive,e_password) 
                 VALUES ?`,
        [employeeValues],
      );
    }

    const owner = input.employees.find((e) => e.e_status === "Owner");
    const logData = {
      st_id: stId,
      stl_type: mapStatusToType(initialStatus),
      stl_actor: requiresSellerConfirmation
        ? `${eData?.e_status ?? "Admin"} ${eData?.e_firstname ?? "Arcana"}`
        : createdByPlatformStore
          ? `${eData?.e_status ?? "Admin"} ${eData?.e_firstname ?? "Arcana"}`
          : `${owner?.e_status ?? ""} ${owner?.e_firstname ?? ""}`.trim(),
      stl_action: mapStatusToAction(initialStatus),
      stl_node: requiresSellerConfirmation
        ? "Admin created store draft and sent seller confirmation"
        : createdByPlatformStore
          ? "Admin Arcana Create Store"
          : "Owner Create Store",
      stl_timestamp: new Date(),
    };
    await conn.query<ResultSetHeader>(`INSERT INTO Store_Logs SET ?`, [
      logData,
    ]);

    const notiEmp = await notiService.getEmpBySTId(stId);

    // if (notiEmp.length > 0) {
    const notiData: NotificationInput = {
      target_type: "STORE",
      target_id: stId,
      type: "NEW_STORE",
      title: "Registro de consignador",
      message: "El registro del consignador se completó correctamente.",
      action_url: "/dashboard/myShop/",
      ref_type: "STORE",
      ref_id: stId,
    };
    await notiService.CreateNotification(notiData);
    // }

    // ===== Commit =====
    await conn.commit();
    return stId;
  } catch (err) {
    // ===== Rollback =====
    await conn.rollback();

    if (isDupError(err)) {
      console.log(`Duplicate entry error: ${err}`);
      throw new ApiError(
        409,
        "Este nombre de tienda o correo electrónico ya está en uso. Verifícalo de nuevo.",
      );
    }
    console.error(`Error creating store register: ${err}`);
    throw err;
  } finally {
    // ===== คืน connection กลับ pool =====
    conn.release();
  }
}

export type SellerConfirmationSummary = {
  store: {
    st_id: number;
    st_number: string;
    st_company_name: string;
    st_email: string;
    st_phone: string | null;
    st_status: string;
  };
  tax: {
    legal_name: string;
    tax_id_number: string;
    tax_seller_type: string;
    tax_address: string;
    tax_zip_code: string;
  } | null;
  employees: {
    e_firstname: string | null;
    e_lastname: string | null;
    e_email: string;
    e_phone: string | null;
    e_status: string;
  }[];
  expires_at: string;
};

export async function createSellerConfirmationInvite(input: {
  stId: number;
  createdByEmpId?: number | null;
}): Promise<{ token: string; expiresAt: Date }> {
  await ensureSellerConfirmationTable();
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashSellerConfirmationToken(token);
  const expiresAt = new Date(
    Date.now() + SELLER_CONFIRMATION_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
  );

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE Store_Seller_Confirmation_Tokens
             SET used_at = ?
             WHERE st_id = ? AND used_at IS NULL`,
      [new Date(), input.stId],
    );
    await conn.query(
      `INSERT INTO Store_Seller_Confirmation_Tokens
             (st_id, token_hash, expires_at, created_by_emp_id)
             VALUES (?, ?, ?, ?)`,
      [input.stId, tokenHash, expiresAt, input.createdByEmpId ?? null],
    );
    await conn.commit();
    return { token, expiresAt };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function getSellerConfirmationRecipient(stId: number): Promise<{
  storeName: string;
  ownerEmail: string;
}> {
  const [storeRows] = await pool.query<
    (RowDataPacket & {
      st_company_name: string;
      st_status: string;
    })[]
  >(
    `SELECT st_company_name, st_status
         FROM Store
         WHERE st_id = ?
         LIMIT 1`,
    [stId],
  );
  const storeRow = storeRows[0];
  if (!storeRow) throw new ApiError(404, CommonMessages.notFound);
  if (storeRow.st_status !== "PENDING_SELLER_CONFIRMATION") {
    throw new ApiError(400, "Esta tienda no está en estado de espera de confirmación del vendedor.");
  }

  const [ownerRows] = await pool.query<(RowDataPacket & { e_email: string })[]>(
    `SELECT e_email
         FROM Employees
         WHERE st_id = ? AND e_status = 'Owner'
         ORDER BY e_id ASC
         LIMIT 1`,
    [stId],
  );
  const ownerEmail = String(ownerRows[0]?.e_email ?? "").trim();
  if (!ownerEmail) {
    throw new ApiError(400, "No se encontró el correo electrónico del Owner para enviar el enlace de confirmación de la tienda.");
  }

  return {
    storeName: storeRow.st_company_name,
    ownerEmail,
  };
}

export async function createStoreEmailVerificationInvite(input: {
  stId: number;
  createdByEmpId?: number | null;
}): Promise<{
  token: string;
  expiresAt: Date;
  email: string;
  storeName: string;
}> {
  await ensureStoreEmailVerificationTable();
  const [storeRows] = await pool.query<
    (RowDataPacket & {
      st_company_name: string;
      st_email: string;
    })[]
  >(
    `SELECT st_company_name, st_email
         FROM Store
         WHERE st_id = ?
         LIMIT 1`,
    [input.stId],
  );
  const storeRow = storeRows[0];
  if (!storeRow) throw new ApiError(404, CommonMessages.notFound);

  const email = String(storeRow.st_email ?? "").trim();
  if (!email) {
    throw new ApiError(400, "No se encontró el correo electrónico de la tienda para enviar el enlace de verificación.");
  }

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashStoreEmailVerificationToken(token);
  const expiresAt = new Date(
    Date.now() +
      STORE_EMAIL_VERIFICATION_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
  );

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE Store_Email_Verification_Tokens
             SET used_at = ?
             WHERE st_id = ? AND email = ? AND used_at IS NULL AND confirmed_at IS NULL`,
      [new Date(), input.stId, email],
    );
    await conn.query(
      `INSERT INTO Store_Email_Verification_Tokens
             (st_id, email, token_hash, expires_at, created_by_emp_id)
             VALUES (?, ?, ?, ?, ?)`,
      [input.stId, email, tokenHash, expiresAt, input.createdByEmpId ?? null],
    );
    await conn.commit();
    return {
      token,
      expiresAt,
      email,
      storeName: storeRow.st_company_name,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function confirmStoreEmail(input: {
  token: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ storeId: number; storeName: string; email: string }> {
  await ensureStoreEmailVerificationTable();
  const tokenHash = hashStoreEmailVerificationToken(input.token);
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    const [tokenRows] = await conn.query<
      (RowDataPacket & {
        sevt_id: number;
        st_id: number;
        email: string;
        expires_at: Date;
        used_at: Date | null;
        confirmed_at: Date | null;
      })[]
    >(
      `SELECT sevt_id, st_id, email, expires_at, used_at, confirmed_at
             FROM Store_Email_Verification_Tokens
             WHERE token_hash = ?
             LIMIT 1
             FOR UPDATE`,
      [tokenHash],
    );
    const tokenRow = tokenRows[0];
    if (
      !tokenRow ||
      tokenRow.used_at ||
      tokenRow.confirmed_at ||
      new Date(tokenRow.expires_at).getTime() <= Date.now()
    ) {
      throw new ApiError(400, "El enlace de verificación de correo de la tienda no es válido o ha caducado.");
    }

    const [storeRows] = await conn.query<
      (RowDataPacket & {
        st_company_name: string;
        st_email: string;
      })[]
    >(
      `SELECT st_company_name, st_email
             FROM Store
             WHERE st_id = ?
             LIMIT 1
             FOR UPDATE`,
      [tokenRow.st_id],
    );
    const storeRow = storeRows[0];
    if (!storeRow) throw new ApiError(404, CommonMessages.notFound);
    if (String(storeRow.st_email ?? "").trim() !== tokenRow.email) {
      throw new ApiError(
        400,
        "El correo electrónico de la tienda ha cambiado. Solicita un nuevo enlace de verificación.",
      );
    }

    const confirmedAt = new Date();
    await conn.query(
      `UPDATE Store_Email_Verification_Tokens
             SET used_at = ?, confirmed_at = ?, confirmed_ip = ?, confirmed_user_agent = ?
             WHERE sevt_id = ?`,
      [
        confirmedAt,
        confirmedAt,
        input.ip ?? null,
        input.userAgent ? input.userAgent.slice(0, 255) : null,
        tokenRow.sevt_id,
      ],
    );
    await conn.query<ResultSetHeader>(`INSERT INTO Store_Logs SET ?`, [
      {
        st_id: tokenRow.st_id,
        stl_type: "PENDING",
        stl_actor: "Store",
        stl_action: "Correo electrónico de la tienda verificado",
        stl_node: `Store email verified: ${tokenRow.email}`,
        stl_timestamp: confirmedAt,
      },
    ]);

    await conn.commit();

    const notiData: NotificationInput = {
      target_type: "STORE",
      target_id: tokenRow.st_id,
      type: "STORE_EMAIL_VERIFIED",
      title: "Correo de la tienda verificado",
      message: `La tienda ${storeRow.st_company_name} verificó el correo ${tokenRow.email}.`,
      action_url: "/dashboard/myShop/",
      ref_type: "STORE",
      ref_id: tokenRow.st_id,
      priority: "NORMAL",
    };
    notiService.CreateNotification(notiData).catch((error) => {
      console.warn(
        `[stores] create store email verification notification failed for store ${tokenRow.st_id}:`,
        error,
      );
    });

    return {
      storeId: tokenRow.st_id,
      storeName: storeRow.st_company_name,
      email: tokenRow.email,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getSellerConfirmationTokenRow(tokenHash: string) {
  await ensureSellerConfirmationTable();
  const [rows] = await pool.query<
    (RowDataPacket & {
      sct_id: number;
      st_id: number;
      expires_at: Date;
      used_at: Date | null;
    })[]
  >(
    `SELECT sct_id, st_id, expires_at, used_at
         FROM Store_Seller_Confirmation_Tokens
         WHERE token_hash = ?
         LIMIT 1`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function getSellerConfirmationSummary(
  token: string,
): Promise<SellerConfirmationSummary> {
  const tokenRow = await getSellerConfirmationTokenRow(
    hashSellerConfirmationToken(token),
  );
  if (
    !tokenRow ||
    tokenRow.used_at ||
    new Date(tokenRow.expires_at).getTime() <= Date.now()
  ) {
    throw new ApiError(400, "El enlace de confirmación de la tienda no es válido o ha caducado.");
  }

  const [storeRows] = await pool.query<
    (RowDataPacket & SellerConfirmationSummary["store"])[]
  >(
    `SELECT st_id, st_number, st_company_name, st_email, st_phone, st_status
         FROM Store
         WHERE st_id = ?
         LIMIT 1`,
    [tokenRow.st_id],
  );
  const storeRow = storeRows[0];
  if (!storeRow) throw new ApiError(404, CommonMessages.notFound);
  if (storeRow.st_status !== "PENDING_SELLER_CONFIRMATION") {
    throw new ApiError(
      400,
      "Esta tienda ya confirmó su información o no está en estado de espera de confirmación del vendedor.",
    );
  }

  const [employeeRows] = await pool.query<
    (RowDataPacket & SellerConfirmationSummary["employees"][number])[]
  >(
    `SELECT e_firstname, e_lastname, e_email, e_phone, e_status
         FROM Employees
         WHERE st_id = ?
         ORDER BY e_status = 'Owner' DESC, e_id ASC`,
    [tokenRow.st_id],
  );

  return {
    store: storeRow,
    tax: null,
    employees: employeeRows,
    expires_at: new Date(tokenRow.expires_at).toISOString(),
  };
}

export async function confirmSellerStore(input: {
  token: string;
  ownerPasswordHash: string;
  pdpaNoticeVersion: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<number> {
  await ensureSellerConfirmationTable();
  await ensureEmployeeEmailVerificationTable();
  const tokenHash = hashSellerConfirmationToken(input.token);
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    const [tokenRows] = await conn.query<
      (RowDataPacket & {
        sct_id: number;
        st_id: number;
        expires_at: Date;
        used_at: Date | null;
      })[]
    >(
      `SELECT sct_id, st_id, expires_at, used_at
             FROM Store_Seller_Confirmation_Tokens
             WHERE token_hash = ?
             LIMIT 1
             FOR UPDATE`,
      [tokenHash],
    );
    const tokenRow = tokenRows[0];
    if (
      !tokenRow ||
      tokenRow.used_at ||
      new Date(tokenRow.expires_at).getTime() <= Date.now()
    ) {
      throw new ApiError(400, "El enlace de confirmación de la tienda no es válido o ha caducado.");
    }

    const [storeRows] = await conn.query<
      (RowDataPacket & { st_status: string; st_company_name: string })[]
    >(
      `SELECT st_status, st_company_name FROM Store WHERE st_id = ? LIMIT 1 FOR UPDATE`,
      [tokenRow.st_id],
    );
    const storeRow = storeRows[0];
    if (!storeRow) throw new ApiError(404, CommonMessages.notFound);
    if (storeRow.st_status !== "PENDING_SELLER_CONFIRMATION") {
      throw new ApiError(
        400,
        "Esta tienda ya confirmó su información o no está en estado de espera de confirmación del vendedor.",
      );
    }
    const [ownerRows] = await conn.query<
      (RowDataPacket & { e_id: number; e_email: string })[]
    >(
      `SELECT e_id, e_email
             FROM Employees
             WHERE st_id = ? AND e_status = 'Owner'
             ORDER BY e_id ASC`,
      [tokenRow.st_id],
    );
    const owner = ownerRows[0];
    if (ownerRows.length !== 1 || !owner) {
      throw new ApiError(400, "La tienda pendiente de confirmación debe tener un único Owner principal.");
    }

    await conn.query(
      `UPDATE Store
             SET st_status = ?, updated_at = ?
             WHERE st_id = ?`,
      ["PENDING", new Date(), tokenRow.st_id],
    );
    const [ownerResult] = await conn.query<ResultSetHeader>(
      `UPDATE Employees
             SET e_password = ?, e_isActive = 1
             WHERE e_id = ?`,
      [input.ownerPasswordHash, owner.e_id],
    );
    if (ownerResult.affectedRows !== 1) {
      throw new ApiError(400, "La tienda pendiente de confirmación debe tener un único Owner principal.");
    }
    await conn.query(
      `UPDATE Store_Seller_Confirmation_Tokens
             SET used_at = ?, confirmed_at = ?, confirmed_ip = ?, confirmed_user_agent = ?, pdpa_notice_version = ?
             WHERE sct_id = ?`,
      [
        new Date(),
        new Date(),
        input.ip ?? null,
        input.userAgent ? input.userAgent.slice(0, 255) : null,
        input.pdpaNoticeVersion,
        tokenRow.sct_id,
      ],
    );
    const employeeEmailVerificationTokenHash = crypto
      .createHash("sha256")
      .update(
        `seller-confirmed-owner-email:${owner.e_id}:${owner.e_email}:${tokenRow.sct_id}`,
      )
      .digest("hex");
    await conn.query(
      `INSERT INTO Employee_Email_Verification_Tokens
             (e_id, email, token_hash, expires_at, confirmed_at, used_at, requires_password_setup, request_ip, user_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        owner.e_id,
        owner.e_email,
        employeeEmailVerificationTokenHash,
        new Date(),
        new Date(),
        new Date(),
        0,
        input.ip ?? null,
        input.userAgent ? input.userAgent.slice(0, 255) : null,
      ],
    );
    await conn.query<ResultSetHeader>(`INSERT INTO Store_Logs SET ?`, [
      {
        st_id: tokenRow.st_id,
        stl_type: "PENDING",
        stl_actor: "Seller",
        stl_action: "El consignador confirmó sus datos y el aviso de privacidad",
        stl_node: `Seller confirmed invite for ${storeRow.st_company_name}`,
        stl_timestamp: new Date(),
      },
    ]);

    await conn.commit();

    notiService
      .NotifyPlatformStores({
        target_type: "STORE",
        type: "SELLER_PDPA_CONFIRMED",
        title: "El consignador confirmó el aviso de privacidad",
        message: `La tienda ${storeRow.st_company_name} confirmó sus datos y el aviso de privacidad. Está pendiente de revisión.`,
        action_url: `/dashboard/store/dataStore/?st_id=${tokenRow.st_id}`,
        ref_type: "STORE",
        ref_id: tokenRow.st_id,
        priority: "HIGH",
      })
      .catch((error) => {
        console.warn(
          `[stores] create seller PDPA confirmation notification failed for store ${tokenRow.st_id}:`,
          error,
        );
      });

    return tokenRow.st_id;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// export async function CreateStore(input: CreateStoreInput): Promise<number> {
//     try {

//         const data = {
//             st_company_name: input.st_company_name,
//             bank_account_number: input.bank_account_number,
//             st_email: input.st_email,
//             st_phone: input.st_phone,
//             st_image: input.st_image,
//             e_id: input.e_id,
//             bk_id: input.bk_id
//         } = input;

//         const [res] = await pool.query<ResultSetHeader>(`INSERT INTO Store  SET ?`, data);
//         return res.insertId;

//     } catch (err) {
//         if (isDupError(err)) {
//             console.log(`Duplicate entry error: ${err}`);
//             throw new ApiError(409, CommonMessages.isExits);
//         }
//         console.error(`Error creating store: ${err}`);
//         throw err;
//     }
// }

export async function updateStore(
  st_id: number,
  input: UpdateStoreInput,
): Promise<void> {
  try {
    const data: any = {
      st_company_name: input.st_company_name,
      st_phone: input.st_phone,
      st_image: input.st_image,
    };
    if (input.bank_account_number !== undefined) {
      data.bank_account_number = input.bank_account_number;
    }
    if (input.st_email !== undefined) {
      data.st_email = input.st_email;
    }
    if (input.bk_id !== undefined) {
      data.bk_id = input.bk_id;
    }
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE Store SET ? WHERE st_id = ?`,
      [data, st_id],
    );
    if (res.affectedRows === 0) {
      throw new ApiError(404, CommonMessages.notFound);
    }
  } catch (err) {
    if (isDupError(err)) {
      throw new ApiError(409, CommonMessages.isExits);
    }
    throw err;
  }
}

export async function deleteStore(st_id: number): Promise<void> {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    await ensureSellerConfirmationTable();
    await ensureStoreEmailVerificationTable();
    await ensureEmployeeEmailVerificationTable();
    await ensureEmployeePasswordResetTable();

    const [employeeRows] = await conn.query<
      (RowDataPacket & { e_id: number })[]
    >(`SELECT e_id FROM Employees WHERE st_id = ?`, [st_id]);
    const employeeIds = employeeRows
      .map((employee) => Number(employee.e_id))
      .filter(Boolean);

    await conn.query<ResultSetHeader>(
      `DELETE FROM Notifications
             WHERE (target_type = 'STORE' AND target_id = ?)
                OR (ref_type = 'STORE' AND ref_id = ?)`,
      [st_id, st_id],
    );

    await conn.query<ResultSetHeader>(
      `DELETE FROM Store_Email_Verification_Tokens WHERE st_id = ?`,
      [st_id],
    );

    await conn.query<ResultSetHeader>(
      `DELETE FROM Store_Seller_Confirmation_Tokens WHERE st_id = ?`,
      [st_id],
    );

    if (employeeIds.length > 0) {
      await conn.query<ResultSetHeader>(
        `DELETE FROM Employee_Email_Verification_Tokens WHERE e_id IN (?)`,
        [employeeIds],
      );

      await conn.query<ResultSetHeader>(
        `DELETE FROM Employee_Password_Reset_Tokens WHERE e_id IN (?)`,
        [employeeIds],
      );
    }

    await conn.query<ResultSetHeader>(
      `DELETE FROM seller_applications WHERE created_store_id = ?`,
      [st_id],
    );

    await conn.query<ResultSetHeader>(`DELETE FROM Locations WHERE st_id = ?`, [
      st_id,
    ]);

    await conn.query<ResultSetHeader>(
      `DELETE FROM Store_Logs WHERE st_id = ?`,
      [st_id],
    );

    await conn.query<ResultSetHeader>(`DELETE FROM Employees WHERE st_id = ?`, [
      st_id,
    ]);

    const [res] = await conn.query<ResultSetHeader>(
      `DELETE FROM Store WHERE st_id = ?`,
      [st_id],
    );

    if (res.affectedRows === 0) {
      throw new ApiError(404, CommonMessages.notFound);
    }

    await conn.commit();
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

export async function listBanks(): Promise<BankDTO[]> {
  const [rows] = await pool.query<RowDataPacket[] & BankDTO[]>(
    `SELECT bk_id, bk_name FROM Bank order by bk_id asc`,
  );
  return rows;
}
