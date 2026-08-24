import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { CreateEmpInput, CreateLocationInput, CreateStoreInput, empDTO, UpdateEmpInput } from "./emp.type.js";
import { pool } from "../../db/pool.js";
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import crypto from "crypto";

const MAX_SELLER_STORE_EMPLOYEES = 3;
const EMPLOYEE_EMAIL_VERIFICATION_EXPIRES_HOURS = 48;

async function MaxId(): Promise<number> {
    try {
        const [rows] = await pool.query<RowDataPacket[]>(`SELECT MAX(CAST(RIGHT(e_usercode, 3) AS UNSIGNED)) AS max_suffix FROM employees`);
        const maxId = rows[0]?.max_suffix;
        return maxId || 0;
    } catch (err) {
        throw err;
    }

}

async function generateUserCode(): Promise<string> {
    try {
        const maxId = await MaxId();
        const newId = maxId + 1;
        return `EMP${newId.toString().padStart(3, '0')}`;
    } catch (err) {
        throw err;
    }
}
export async function findByEmpLogin(e_email: string): Promise<empDTO | null> {
    await ensureEmployeeEmailVerificationTable();
    await pool.query(`CREATE TABLE IF NOT EXISTS Store_Seller_Confirmation_Tokens (
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
    )`);
    const [rows] = await pool.query<(empDTO & RowDataPacket)[]>(
        `SELECT a.*,
                b.st_company_name,
                b.st_image,
                b.is_platform_store,
                ${employeeEmailVerifiedAtSql("a")} AS e_email_verified_at
        FROM Employees a 
        INNER JOIN Store b ON a.st_id = b.st_id
        WHERE a.e_email = ?`,
        [e_email],
    );
    return rows[0] || null;
}

async function ensurePasswordResetTable(): Promise<void> {
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

function employeeEmailVerifiedAtSql(alias: string): string {
    return `COALESCE(
        (
            SELECT MAX(eevt.confirmed_at)
            FROM Employee_Email_Verification_Tokens eevt
            WHERE eevt.e_id = ${alias}.e_id
              AND eevt.email = ${alias}.e_email
              AND eevt.confirmed_at IS NOT NULL
        ),
        CASE
            WHEN ${alias}.e_status = 'Owner' THEN (
                SELECT MAX(sct.confirmed_at)
                FROM Store_Seller_Confirmation_Tokens sct
                WHERE sct.st_id = ${alias}.st_id
                  AND sct.confirmed_at IS NOT NULL
                  AND ${alias}.e_add_datetime IS NOT NULL
                  AND ${alias}.e_add_datetime <= sct.confirmed_at
            )
            ELSE NULL
        END
    )`;
}

export async function findPasswordResetEmployeeByEmail(e_email: string): Promise<Pick<empDTO, "e_id" | "e_firstname" | "e_lastname" | "e_email" | "e_isActive"> | null> {
    const [rows] = await pool.query<(Pick<empDTO, "e_id" | "e_firstname" | "e_lastname" | "e_email" | "e_isActive"> & RowDataPacket)[]>(
        `SELECT e_id, e_firstname, e_lastname, e_email, e_isActive
         FROM Employees
         WHERE e_email = ?
         LIMIT 1`,
        [e_email],
    );
    return rows[0] || null;
}

export async function createPasswordResetToken(input: {
    e_id: number;
    tokenHash: string;
    expiresAt: Date;
    requestIp?: string | null;
    userAgent?: string | null;
}): Promise<void> {
    await ensurePasswordResetTable();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query(
            `UPDATE Employee_Password_Reset_Tokens
             SET used_at = ?
             WHERE e_id = ? AND used_at IS NULL`,
            [new Date(), input.e_id],
        );
        await conn.query(
            `INSERT INTO Employee_Password_Reset_Tokens
             (e_id, token_hash, expires_at, request_ip, user_agent)
             VALUES (?, ?, ?, ?, ?)`,
            [
                input.e_id,
                input.tokenHash,
                input.expiresAt,
                input.requestIp ?? null,
                input.userAgent ? input.userAgent.slice(0, 255) : null,
            ],
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function resetPasswordWithToken(tokenHash: string, hashedPassword: string): Promise<void> {
    await ensurePasswordResetTable();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query<(RowDataPacket & {
            prt_id: number;
            e_id: number;
            expires_at: Date;
            used_at: Date | null;
        })[]>(
            `SELECT prt_id, e_id, expires_at, used_at
             FROM Employee_Password_Reset_Tokens
             WHERE token_hash = ?
             LIMIT 1
             FOR UPDATE`,
            [tokenHash],
        );
        const resetToken = rows[0];
        if (!resetToken || resetToken.used_at || new Date(resetToken.expires_at).getTime() <= Date.now()) {
            throw new ApiError(400, "ลิงก์ตั้งรหัสผ่านไม่ถูกต้องหรือหมดอายุแล้ว");
        }

        const [employeeResult] = await conn.query<ResultSetHeader>(
            `UPDATE Employees SET e_password = ? WHERE e_id = ?`,
            [hashedPassword, resetToken.e_id],
        );
        if (employeeResult.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        await conn.query(
            `UPDATE Employee_Password_Reset_Tokens
             SET used_at = ?
             WHERE e_id = ? AND used_at IS NULL`,
            [new Date(), resetToken.e_id],
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function findByEmpId(e_id: number): Promise<empDTO | null> {
    await ensureEmployeeEmailVerificationTable();
    await pool.query(`CREATE TABLE IF NOT EXISTS Store_Seller_Confirmation_Tokens (
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
    )`);
    const [rows] = await pool.query<(empDTO & RowDataPacket)[]>(
        `SELECT e.*,
                ${employeeEmailVerifiedAtSql("e")} AS e_email_verified_at
         FROM Employees e
         WHERE e.e_id = ?`,
        [e_id],
    );
    return rows[0] || null;
}

async function countActiveOwners(st_id: number, excludeEmpId?: number): Promise<number> {
    const params: (number | string)[] = [st_id, "Owner"];
    let sql = `SELECT COUNT(*) AS total FROM Employees WHERE st_id = ? AND e_status = ? AND e_isActive = 1`;

    if (excludeEmpId) {
        sql += ` AND e_id <> ?`;
        params.push(excludeEmpId);
    }

    const [rows] = await pool.query<RowDataPacket[]>(sql, params);
    return Number(rows[0]?.total ?? 0);
}

async function assertStoreKeepsActiveOwner(st_id: number, excludeEmpId?: number): Promise<void> {
    const ownerCount = await countActiveOwners(st_id, excludeEmpId);
    if (ownerCount < 1) {
        throw new ApiError(400, "ร้านต้องมี Owner ที่ใช้งานได้อย่างน้อย 1 คน");
    }
}

function toActiveBoolean(value: unknown): boolean {
    return value === true || value === 1 || value === "1" || value === "true";
}

async function isPlatformStore(st_id: number): Promise<boolean> {
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT is_platform_store FROM Store WHERE st_id = ? LIMIT 1`, [st_id]);
    const value = rows[0]?.is_platform_store;
    return value === true || value === 1 || value === "1";
}

async function countStoreEmployees(st_id: number): Promise<number> {
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM Employees WHERE st_id = ?`, [st_id]);
    return Number(rows[0]?.total ?? 0);
}



export async function listEmps(st_id: number): Promise<empDTO[]> {
    await ensureEmployeeEmailVerificationTable();
    await pool.query(`CREATE TABLE IF NOT EXISTS Store_Seller_Confirmation_Tokens (
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
    )`);
    const [rows] = await pool.query<(RowDataPacket[]) & empDTO[]>(
        `SELECT e.*,
                ${employeeEmailVerifiedAtSql("e")} AS e_email_verified_at
         FROM Employees e
         WHERE e.st_id = ?
         ORDER BY e.e_id ASC`,
        [st_id],
    );
    return rows;
}

export async function markEmployeeEmailVerified(input: {
    e_id: number;
    email: string;
    confirmedAt?: Date;
    requestIp?: string | null;
    userAgent?: string | null;
}): Promise<void> {
    await ensureEmployeeEmailVerificationTable();
    const confirmedAt = input.confirmedAt ?? new Date();
    const tokenHash = crypto
        .createHash("sha256")
        .update(`employee-email-verified:${input.e_id}:${input.email}:${confirmedAt.toISOString()}:${crypto.randomBytes(16).toString("hex")}`)
        .digest("hex");

    await pool.query(
        `INSERT INTO Employee_Email_Verification_Tokens
         (e_id, email, token_hash, expires_at, confirmed_at, used_at, requires_password_setup, request_ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            input.e_id,
            input.email,
            tokenHash,
            confirmedAt,
            confirmedAt,
            confirmedAt,
            0,
            input.requestIp ?? null,
            input.userAgent ? input.userAgent.slice(0, 255) : null,
        ],
    );
}

export async function CreateEmpAdmins(input: CreateEmpInput): Promise<number> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const stId = Number(input.st_id);
        if (!stId) {
            throw new ApiError(400, "รหัสร้านไม่ถูกต้อง");
        }

        const employeeCount = await countStoreEmployees(stId);
        if (employeeCount >= MAX_SELLER_STORE_EMPLOYEES) {
            throw new ApiError(400, `เพิ่มผู้ดูแลร้าน/พนักงานได้สูงสุด ${MAX_SELLER_STORE_EMPLOYEES} คน`);
        }

        const platformStore = await isPlatformStore(stId);
        if (!platformStore && !["Owner", "Staff"].includes(input.e_status)) {
            throw new ApiError(400, "ร้านผู้ฝากขายเพิ่มได้เฉพาะ Owner หรือ Staff เท่านั้น");
        }

        const [res] = await conn.query<ResultSetHeader>(`INSERT INTO Employees SET ?`, [input]);
        await conn.commit();
        return res.insertId;
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    }
}

export async function createEmployeeEmailVerificationInvite(input: {
    e_id: number;
    tokenHash: string;
    expiresAt?: Date;
    requiresPasswordSetup?: boolean;
    requestIp?: string | null;
    userAgent?: string | null;
}): Promise<{
    e_id: number;
    email: string;
    name: string | null;
    storeName: string | null;
    role: string | null;
    expiresAt: Date;
    requiresPasswordSetup: boolean;
}> {
    await ensureEmployeeEmailVerificationTable();
    const expiresAt = input.expiresAt ?? new Date(Date.now() + EMPLOYEE_EMAIL_VERIFICATION_EXPIRES_HOURS * 60 * 60 * 1000);
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();
        const [rows] = await conn.query<(empDTO & RowDataPacket)[]>(
            `SELECT e.*, s.st_company_name
             FROM Employees e
             LEFT JOIN Store s ON s.st_id = e.st_id
             WHERE e.e_id = ?
             LIMIT 1
             FOR UPDATE`,
            [input.e_id],
        );
        const employee = rows[0];
        if (!employee) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        await conn.query(
            `UPDATE Employee_Email_Verification_Tokens
             SET used_at = ?
             WHERE e_id = ? AND used_at IS NULL AND confirmed_at IS NULL`,
            [new Date(), input.e_id],
        );
        await conn.query(
            `INSERT INTO Employee_Email_Verification_Tokens
             (e_id, email, token_hash, expires_at, requires_password_setup, request_ip, user_agent)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                input.e_id,
                employee.e_email,
                input.tokenHash,
                expiresAt,
                input.requiresPasswordSetup ? 1 : 0,
                input.requestIp ?? null,
                input.userAgent ? input.userAgent.slice(0, 255) : null,
            ],
        );

        await conn.commit();
        return {
            e_id: employee.e_id,
            email: employee.e_email,
            name: [employee.e_firstname, employee.e_lastname].filter(Boolean).join(" ").trim() || null,
            storeName: employee.st_company_name ?? null,
            role: employee.e_status ?? null,
            expiresAt,
            requiresPasswordSetup: Boolean(input.requiresPasswordSetup),
        };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function getEmployeeEmailVerificationSummary(tokenHash: string): Promise<{
    email: string;
    name: string | null;
    storeName: string | null;
    role: string | null;
    expiresAt: Date;
    requiresPasswordSetup: boolean;
}> {
    await ensureEmployeeEmailVerificationTable();
    const [rows] = await pool.query<(RowDataPacket & {
        email: string;
        expires_at: Date;
        confirmed_at: Date | null;
        used_at: Date | null;
        requires_password_setup: 0 | 1 | boolean;
        e_firstname: string | null;
        e_lastname: string | null;
        e_email: string;
        e_status: string | null;
        st_company_name: string | null;
    })[]>(
        `SELECT eevt.email, eevt.expires_at, eevt.confirmed_at, eevt.used_at, eevt.requires_password_setup,
                e.e_firstname, e.e_lastname, e.e_email, e.e_status, s.st_company_name
         FROM Employee_Email_Verification_Tokens eevt
         INNER JOIN Employees e ON e.e_id = eevt.e_id
         LEFT JOIN Store s ON s.st_id = e.st_id
         WHERE eevt.token_hash = ?
         LIMIT 1`,
        [tokenHash],
    );
    const token = rows[0];
    if (!token || token.used_at || token.confirmed_at || new Date(token.expires_at).getTime() <= Date.now()) {
        throw new ApiError(400, "ลิงก์ยืนยันอีเมลไม่ถูกต้องหรือหมดอายุแล้ว");
    }
    if (token.email !== token.e_email) {
        throw new ApiError(400, "อีเมลของผู้ใช้งานถูกเปลี่ยนแล้ว กรุณาขอลิงก์ยืนยันใหม่");
    }

    return {
        email: token.email,
        name: [token.e_firstname, token.e_lastname].filter(Boolean).join(" ").trim() || null,
        storeName: token.st_company_name ?? null,
        role: token.e_status ?? null,
        expiresAt: token.expires_at,
        requiresPasswordSetup: Boolean(token.requires_password_setup),
    };
}

export async function confirmEmployeeEmail(input: {
    tokenHash: string;
    passwordHash?: string | null;
    requestIp?: string | null;
    userAgent?: string | null;
}): Promise<{ employeeId: number; email: string; name: string | null; storeName: string | null; passwordWasSet: boolean }> {
    await ensureEmployeeEmailVerificationTable();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query<(RowDataPacket & {
            eevt_id: number;
            e_id: number;
            email: string;
            expires_at: Date;
            confirmed_at: Date | null;
            used_at: Date | null;
            requires_password_setup: 0 | 1 | boolean;
            e_firstname: string | null;
            e_lastname: string | null;
            e_email: string;
            st_company_name: string | null;
        })[]>(
            `SELECT eevt.*, e.e_firstname, e.e_lastname, e.e_email, s.st_company_name
             FROM Employee_Email_Verification_Tokens eevt
             INNER JOIN Employees e ON e.e_id = eevt.e_id
             LEFT JOIN Store s ON s.st_id = e.st_id
             WHERE eevt.token_hash = ?
             LIMIT 1
             FOR UPDATE`,
            [input.tokenHash],
        );
        const token = rows[0];
        if (!token || token.used_at || token.confirmed_at || new Date(token.expires_at).getTime() <= Date.now()) {
            throw new ApiError(400, "ลิงก์ยืนยันอีเมลไม่ถูกต้องหรือหมดอายุแล้ว");
        }
        if (token.email !== token.e_email) {
            throw new ApiError(400, "อีเมลของผู้ใช้งานถูกเปลี่ยนแล้ว กรุณาขอลิงก์ยืนยันใหม่");
        }
        if (Boolean(token.requires_password_setup) && !input.passwordHash) {
            throw new ApiError(400, "กรุณาตั้งรหัสผ่านก่อนยืนยันอีเมล");
        }

        const confirmedAt = new Date();
        if (input.passwordHash) {
            await conn.query(
                `UPDATE Employees SET e_password = ?, e_isActive = 1 WHERE e_id = ?`,
                [input.passwordHash, token.e_id],
            );
        }
        await conn.query(
            `UPDATE Employee_Email_Verification_Tokens
             SET confirmed_at = ?, used_at = ?, request_ip = COALESCE(request_ip, ?), user_agent = COALESCE(user_agent, ?)
             WHERE eevt_id = ?`,
            [
                confirmedAt,
                confirmedAt,
                input.requestIp ?? null,
                input.userAgent ? input.userAgent.slice(0, 255) : null,
                token.eevt_id,
            ],
        );
        await conn.commit();

        return {
            employeeId: token.e_id,
            email: token.email,
            name: [token.e_firstname, token.e_lastname].filter(Boolean).join(" ").trim() || null,
            storeName: token.st_company_name ?? null,
            passwordWasSet: Boolean(input.passwordHash),
        };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}


export async function UpdateEmpAdmins(e_id: number, input: Partial<UpdateEmpInput>): Promise<void> {
    await ensureEmployeeEmailVerificationTable();
    await pool.query(`CREATE TABLE IF NOT EXISTS Store_Seller_Confirmation_Tokens (
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
    )`);
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [currentRows] = await conn.query<(empDTO & RowDataPacket)[]>(
            `SELECT e.*,
                    ${employeeEmailVerifiedAtSql("e")} AS e_email_verified_at
             FROM Employees e
             WHERE e.e_id = ?
             LIMIT 1`,
            [e_id],
        );
        const current = currentRows[0];
        if (!current) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        const nextEmail = input.e_email?.trim().toLowerCase();
        const currentEmail = current.e_email?.trim().toLowerCase();
        if (nextEmail && nextEmail !== currentEmail && current.e_email_verified_at) {
            throw new ApiError(400, "อีเมลนี้ยืนยันแล้ว ไม่สามารถแก้ไขอีเมลได้");
        }

        const nextStatus = input.e_status ?? current.e_status;
        const nextIsActive = input.e_isActive ?? current.e_isActive;
        const willStopBeingActiveOwner = current.e_status === "Owner" && (nextStatus !== "Owner" || !toActiveBoolean(nextIsActive));

        if (willStopBeingActiveOwner) {
            const ownerCount = await countActiveOwners(current.st_id, e_id);
            if (ownerCount < 1) {
                throw new ApiError(400, "ร้านต้องมี Owner ที่ใช้งานได้อย่างน้อย 1 คน");
            }
        }

        const [result] = await conn.query<ResultSetHeader>(`UPDATE Employees SET ? WHERE e_id = ?`, [input, e_id]);
        if (result.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    } finally {
        conn.release();
    }
}

export async function updatePassword(e_id: number, e_password: string): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [result] = await conn.query<ResultSetHeader>(
            `UPDATE Employees SET e_password = ? WHERE e_id = ?`,
            [e_password, e_id]
        );

        if (result.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function DeleteEmpAdmins(e_id: number): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [currentRows] = await conn.query<(empDTO & RowDataPacket)[]>(`SELECT * FROM Employees WHERE e_id = ? LIMIT 1`, [e_id]);
        const current = currentRows[0];
        if (!current) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        if (current.e_status === "Owner" && toActiveBoolean(current.e_isActive)) {
            await assertStoreKeepsActiveOwner(current.st_id, e_id);
        }

        const [result] = await conn.query<ResultSetHeader>(`DELETE FROM Employees WHERE e_id = ?`, [e_id]);

        if (result.affectedRows === 0) {
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


export async function createEmp(inputStore: CreateStoreInput, inputEmp: CreateEmpInput, inputLocation: CreateLocationInput): Promise<number> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const e_usercode = await generateUserCode();

        const Store = {
            st_company_name: inputStore.st_company_name,
            st_idcard: inputStore.st_idcard,
            bank_name: inputStore.bank_name,
            account_number: inputStore.account_number,
            omise_recipient_id: inputStore.omise_recipient_id,
            st_email: inputStore.st_email,
            created_at: inputStore.created_at,
            st_phone: inputStore.st_phone,
            st_image: inputStore.st_image,
            e_id: inputStore.e_id,
        }

        const [resStore] = await conn.query<ResultSetHeader>(`INSERT INTO Store SET ? `, [Store]);
        const st_id = resStore.insertId;
        const emp = {
            e_usercode,
            e_firstname: inputEmp.e_firstname,
            e_lastname: inputEmp.e_lastname,
            e_password: inputEmp.e_password,
            e_email: inputEmp.e_email,
            e_phone: inputEmp.e_phone,
            e_isActive: inputEmp.e_isActive,
            e_status: inputEmp.e_status,
            st_id: st_id
        };

        const [res] = await conn.query<ResultSetHeader>(`INSERT INTO Employees SET ?`, emp);
        const e_id = res.insertId;

        const Locations = {
            loc_name: inputLocation.loc_name,
            loc_address: inputLocation.loc_address,
            loc_postcode: inputLocation.loc_postcode,
            st_id: st_id,
            e_id: e_id,
            Subdistricts_id: inputLocation.Subdistricts_id,
            Districts_id: inputLocation.Districts_id,
            Provinces_id: inputLocation.Provinces_id
        }
        await conn.query(`INSERT INTO Locations  SET ? `, [Locations]);
        await conn.commit();
        return e_id;
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    }
}


