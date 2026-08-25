import bcrypt from "bcrypt";
import crypto from "crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import { ApiError, isDupError } from "../../shared/errors/ApiError.js";
import { UserMessages } from "../../shared/messages/user.messages.js";
import type { AddAddressInput, AddressDTO, AuthResult, FacebookUserInfo, GoogleUserInfo, ProfileDTO, RefreshTokenSessionInput, RegisterBuyerInput, RegisterBuyerDTO } from "./type.js";

const REFRESH_TOKEN_DAYS = 30;
let refreshTokenTableReady: Promise<void> | null = null;
let passwordResetTableReady: Promise<void> | null = null;

function hashRefreshToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function buildRefreshToken(): string {
    return crypto.randomBytes(48).toString("base64url");
}

function getRefreshExpiresAt(): Date {
    return new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
}

async function ensureRefreshTokenTable(): Promise<void> {
    refreshTokenTableReady ??= pool.query(`
        CREATE TABLE IF NOT EXISTS User_refresh_tokens (
            urt_id BIGINT NOT NULL AUTO_INCREMENT,
            u_id INT NOT NULL,
            token_hash CHAR(64) NOT NULL,
            expires_at DATETIME NOT NULL,
            revoked_at DATETIME NULL,
            replaced_by_hash CHAR(64) NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_used_at DATETIME NULL,
            user_agent VARCHAR(255) NULL,
            ip_address VARCHAR(64) NULL,
            PRIMARY KEY (urt_id),
            UNIQUE KEY uq_user_refresh_token_hash (token_hash),
            KEY idx_user_refresh_tokens_user (u_id, revoked_at, expires_at)
        )
    `).then(() => undefined);

    return refreshTokenTableReady;
}

async function ensurePasswordResetTable(): Promise<void> {
    passwordResetTableReady ??= pool.query(`
        CREATE TABLE IF NOT EXISTS User_password_reset_tokens (
            uprt_id BIGINT NOT NULL AUTO_INCREMENT,
            u_id INT NOT NULL,
            token_hash CHAR(64) NOT NULL,
            expires_at DATETIME NOT NULL,
            used_at DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            request_ip VARCHAR(64) NULL,
            user_agent VARCHAR(255) NULL,
            PRIMARY KEY (uprt_id),
            UNIQUE KEY uq_user_password_reset_token_hash (token_hash),
            KEY idx_user_password_reset_user (u_id, used_at, expires_at)
        )
    `).then(() => undefined);

    return passwordResetTableReady;
}

export const refreshTokenConfig = {
    cookieName: "arcana_refresh_token",
    maxAgeMs: REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000,
};

export async function registerBuyer(input: RegisterBuyerInput): Promise<RegisterBuyerDTO> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const hashedPassword = await bcrypt.hash(input.u_password, 10);

        const userData = {
            u_username: input.u_username,
            u_email: input.u_email,
            u_password: hashedPassword,
            u_birthday: input.u_birthday ?? null,
            u_gender: input.u_gender ?? null,
            u_provider: input.u_provider,
            u_email_verified: 0,
            u_create_at: new Date(),
        };

        const [userRes] = await conn.query<ResultSetHeader>("INSERT INTO Users SET ?", [userData]);
        const u_id = userRes.insertId;

        const locationData = {
            u_id,
            locb_recipient_name: input.locb_recipient_name,
            locb_phone: input.locb_phone,
            locb_address: input.locb_address,
            provinces_id: null,
            districts_id: null,
            subdistricts_id: null,
            colonia: input.colonia,
            municipality: input.municipality,
            city: input.city,
            state: input.state,
            zip_code: input.zip_code,
            country_code: input.country_code,
            latitude: input.latitude ?? null,
            longitude: input.longitude ?? null,
            formatted_address: input.formatted_address ?? null,
            is_default: input.is_default ? 1 : 0,
        };

        await conn.query<ResultSetHeader>("INSERT INTO Locations_buyer SET ?", [locationData]);

        await conn.commit();

        const [rows] = await conn.query<(RowDataPacket & RegisterBuyerDTO)[]>(
            "SELECT u_id, u_username, u_email, u_avatar, u_create_at FROM Users WHERE u_id = ?",
            [u_id]
        );

        if (!rows[0]) throw new ApiError(500, "เกิดข้อผิดพลาดในการบันทึกข้อมูล");
        return rows[0];
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, UserMessages.repeatEmail);
        throw err;
    } finally {
        conn.release();
    }
}

export async function facebookAuth(accessToken: string): Promise<AuthResult> {
    const res = await fetch(
        `https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${accessToken}`
    );
    if (!res.ok) throw new ApiError(401, "access_token ไม่ถูกต้องหรือหมดอายุ");

    const fbUser = (await res.json()) as FacebookUserInfo;

    const [existing] = await pool.query<(RowDataPacket & RegisterBuyerDTO)[]>(
        fbUser.email
            ? "SELECT u_id, u_username, u_email, u_avatar, u_create_at FROM Users WHERE u_email = ? OR u_provider_id = ? LIMIT 1"
            : "SELECT u_id, u_username, u_email, u_avatar, u_create_at FROM Users WHERE u_provider_id = ? LIMIT 1",
        fbUser.email ? [fbUser.email, fbUser.id] : [fbUser.id]
    );

    if (existing[0]) {
        await pool.query("UPDATE Users SET u_last_login = ? WHERE u_id = ?", [new Date(), existing[0].u_id]);
        return { user: existing[0], isNew: false };
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const userData = {
            u_username: fbUser.name,
            u_email: fbUser.email ?? null,
            u_password: null,
            u_provider: "FACEBOOK",
            u_provider_id: fbUser.id,
            u_avatar: fbUser.picture?.data?.url ?? null,
            u_email_verified: fbUser.email ? 1 : 0,
            u_create_at: new Date(),
            u_last_login: new Date(),
        };

        const [result] = await conn.query<ResultSetHeader>("INSERT INTO Users SET ?", [userData]);
        await conn.commit();

        const [newRows] = await conn.query<(RowDataPacket & RegisterBuyerDTO)[]>(
            "SELECT u_id, u_username, u_email, u_avatar, u_create_at FROM Users WHERE u_id = ?",
            [result.insertId]
        );

        if (!newRows[0]) throw new ApiError(500, "เกิดข้อผิดพลาดในการบันทึกข้อมูล");
        return { user: newRows[0], isNew: true };
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, UserMessages.repeatEmail);
        throw err;
    } finally {
        conn.release();
    }
}

export async function loginBuyer(email: string, password: string): Promise<RegisterBuyerDTO> {
    const [rows] = await pool.query<(RowDataPacket & RegisterBuyerDTO & { u_password: string | null; u_provider: string })[]>(
        "SELECT u_id, u_username, u_email, u_avatar, u_password, u_provider, u_create_at FROM Users WHERE u_email = ? LIMIT 1",
        [email]
    );

    const user = rows[0];
    if (!user) throw new ApiError(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง");
    if (user.u_provider !== "LOCAL" || !user.u_password) throw new ApiError(401, "บัญชีนี้ใช้การเข้าสู่ระบบด้วย " + user.u_provider);

    const match = await bcrypt.compare(password, user.u_password);
    if (!match) throw new ApiError(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง");

    await pool.query("UPDATE Users SET u_last_login = ? WHERE u_id = ?", [new Date(), user.u_id]);

    return { u_id: user.u_id, u_username: user.u_username, u_email: user.u_email, u_avatar: user.u_avatar, u_create_at: user.u_create_at };
}

export async function findPasswordResetBuyerByEmail(email: string): Promise<(RegisterBuyerDTO & {
    u_provider: string;
    has_password: 0 | 1;
}) | null> {
    const [rows] = await pool.query<(RowDataPacket & RegisterBuyerDTO & {
        u_provider: string;
        has_password: 0 | 1;
    })[]>(
        `SELECT u_id, u_username, u_email, u_avatar, u_provider,
                CASE WHEN u_password IS NULL THEN 0 ELSE 1 END AS has_password,
                u_create_at
         FROM Users
         WHERE u_email = ?
         LIMIT 1`,
        [email]
    );

    return rows[0] ?? null;
}

export async function createPasswordResetToken(input: {
    u_id: number;
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
            `UPDATE User_password_reset_tokens
             SET used_at = ?
             WHERE u_id = ? AND used_at IS NULL`,
            [new Date(), input.u_id]
        );
        await conn.query(
            `INSERT INTO User_password_reset_tokens
                (u_id, token_hash, expires_at, request_ip, user_agent)
             VALUES (?, ?, ?, ?, ?)`,
            [
                input.u_id,
                input.tokenHash,
                input.expiresAt,
                input.requestIp?.slice(0, 64) ?? null,
                input.userAgent?.slice(0, 255) ?? null,
            ]
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
            uprt_id: number;
            u_id: number;
            expires_at: Date;
            used_at: Date | null;
            u_provider: string;
            u_password: string | null;
        })[]>(
            `SELECT prt.uprt_id, prt.u_id, prt.expires_at, prt.used_at, u.u_provider, u.u_password
             FROM User_password_reset_tokens prt
             INNER JOIN Users u ON u.u_id = prt.u_id
             WHERE prt.token_hash = ?
             LIMIT 1
             FOR UPDATE`,
            [tokenHash]
        );

        const resetToken = rows[0];
        if (
            !resetToken ||
            resetToken.used_at ||
            new Date(resetToken.expires_at).getTime() <= Date.now() ||
            resetToken.u_provider !== "LOCAL" ||
            !resetToken.u_password
        ) {
            throw new ApiError(400, "ลิงก์ตั้งรหัสผ่านไม่ถูกต้องหรือหมดอายุแล้ว");
        }

        const [result] = await conn.query<ResultSetHeader>(
            `UPDATE Users
             SET u_password = ?
             WHERE u_id = ? AND u_provider = ?`,
            [hashedPassword, resetToken.u_id, "LOCAL"]
        );
        if (result.affectedRows === 0) {
            throw new ApiError(404, "ไม่พบข้อมูลผู้ใช้");
        }

        await conn.query(
            `UPDATE User_password_reset_tokens
             SET used_at = ?
             WHERE u_id = ? AND used_at IS NULL`,
            [new Date(), resetToken.u_id]
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function createRefreshTokenSession(input: RefreshTokenSessionInput): Promise<string> {
    await ensureRefreshTokenTable();

    const refreshToken = buildRefreshToken();
    await pool.query(
        `INSERT INTO User_refresh_tokens
            (u_id, token_hash, expires_at, created_at, user_agent, ip_address)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
            input.u_id,
            hashRefreshToken(refreshToken),
            getRefreshExpiresAt(),
            new Date(),
            input.user_agent?.slice(0, 255) ?? null,
            input.ip_address?.slice(0, 64) ?? null,
        ]
    );

    return refreshToken;
}

export async function rotateRefreshToken(
    refreshToken: string,
    meta: { user_agent?: string | null; ip_address?: string | null }
): Promise<{ user: RegisterBuyerDTO; refreshToken: string }> {
    await ensureRefreshTokenTable();

    const currentHash = hashRefreshToken(refreshToken);
    const nextRefreshToken = buildRefreshToken();
    const nextHash = hashRefreshToken(nextRefreshToken);
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const [rows] = await conn.query<(RowDataPacket & {
            urt_id: number;
            u_id: number;
            expires_at: Date;
            revoked_at: Date | null;
            u_username: string;
            u_email: string;
            u_avatar: string | null;
            u_create_at: string;
        })[]>(
            `SELECT rt.urt_id, rt.u_id, rt.expires_at, rt.revoked_at,
                    u.u_username, u.u_email, u.u_avatar, u.u_create_at
             FROM User_refresh_tokens rt
             INNER JOIN Users u ON u.u_id = rt.u_id
             WHERE rt.token_hash = ?
             LIMIT 1
             FOR UPDATE`,
            [currentHash]
        );

        const session = rows[0];
        if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
            throw new ApiError(401, "Refresh token หมดอายุ กรุณาเข้าสู่ระบบใหม่");
        }

        await conn.query(
            `UPDATE User_refresh_tokens
             SET revoked_at = ?, replaced_by_hash = ?, last_used_at = ?
             WHERE urt_id = ?`,
            [new Date(), nextHash, new Date(), session.urt_id]
        );

        await conn.query(
            `INSERT INTO User_refresh_tokens
                (u_id, token_hash, expires_at, created_at, user_agent, ip_address)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                session.u_id,
                nextHash,
                getRefreshExpiresAt(),
                new Date(),
                meta.user_agent?.slice(0, 255) ?? null,
                meta.ip_address?.slice(0, 64) ?? null,
            ]
        );

        await conn.commit();

        return {
            refreshToken: nextRefreshToken,
            user: {
                u_id: session.u_id,
                u_username: session.u_username,
                u_email: session.u_email,
                u_avatar: session.u_avatar,
                u_create_at: session.u_create_at,
            },
        };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
    await ensureRefreshTokenTable();

    await pool.query(
        "UPDATE User_refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
        [new Date(), hashRefreshToken(refreshToken)]
    );
}

// ─── Profile ────────────────────────────────────────────────────────────────

/** ดึงข้อมูล profile ของ user ที่ล็อกอินอยู่ */
export async function getMyProfile(u_id: number): Promise<ProfileDTO> {
    const [rows] = await pool.query<(RowDataPacket & ProfileDTO)[]>(
        `SELECT u_id, u_username, u_email, u_avatar,
                u_birthday, u_gender, u_provider, u_create_at
         FROM Users WHERE u_id = ? LIMIT 1`,
        [u_id]
    );
    const user = rows[0];
    if (!user) throw new ApiError(404, "ไม่พบข้อมูลผู้ใช้");
    return user;
}

/** อัปเดต username / birthday / gender — email และ provider ห้ามเปลี่ยน */
export async function updateMyProfile(
    u_id: number,
    data: { u_username: string; u_birthday?: string | null; u_gender?: string | null }
): Promise<ProfileDTO> {
    await pool.query(
        "UPDATE Users SET u_username = ?, u_birthday = ?, u_gender = ? WHERE u_id = ?",
        [data.u_username, data.u_birthday ?? null, data.u_gender ?? null, u_id]
    );
    return getMyProfile(u_id);
}

// ─── Password ────────────────────────────────────────────────────────────────

/** เปลี่ยนรหัสผ่าน — ตรวจสอบ current_password ก่อน แล้วค่อย hash และ update */
export async function changePassword(
    u_id: number,
    current_password: string,
    new_password: string
): Promise<void> {
    const [rows] = await pool.query<(RowDataPacket & { u_password: string | null; u_provider: string })[]>(
        "SELECT u_password, u_provider FROM Users WHERE u_id = ? LIMIT 1",
        [u_id]
    );

    const user = rows[0];
    if (!user) throw new ApiError(404, "ไม่พบข้อมูลผู้ใช้");

    // บัญชี Google / Facebook ไม่มี password — ไม่สามารถเปลี่ยนได้
    if (user.u_provider !== "LOCAL" || !user.u_password) {
        throw new ApiError(400, `บัญชีนี้เข้าสู่ระบบด้วย ${user.u_provider} ไม่สามารถเปลี่ยนรหัสผ่านได้`);
    }

    const match = await bcrypt.compare(current_password, user.u_password);
    if (!match) throw new ApiError(400, "รหัสผ่านปัจจุบันไม่ถูกต้อง");

    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query("UPDATE Users SET u_password = ? WHERE u_id = ?", [hashed, u_id]);
}

// ─── Addresses ──────────────────────────────────────────────────────────────

/** ดึงรายการที่อยู่จัดส่งทั้งหมดของ user พร้อมชื่อจังหวัด/อำเภอ/ตำบล */
export async function getMyAddresses(u_id: number): Promise<AddressDTO[]> {
    // แยก raw type เพราะ MySQL คืน is_default เป็น 0/1 (number) ไม่ใช่ boolean
    type RawRow = RowDataPacket & Omit<AddressDTO, "is_default"> & { is_default: number };
    const [rows] = await pool.query<RawRow[]>(
        `SELECT
            lb.locb_id,
            lb.locb_recipient_name,
            lb.locb_phone,
            lb.locb_address,
            lb.country_code,
            lb.state,
            lb.city,
            lb.municipality,
            lb.colonia,
            lb.provinces_id,
            lb.districts_id,
            lb.subdistricts_id,
            lb.zip_code,
            lb.latitude,
            lb.longitude,
            lb.formatted_address,
            lb.is_default,
            lb.state AS province_name,
            COALESCE(lb.municipality, lb.city) AS district_name,
            lb.colonia AS subdistrict_name
         FROM Locations_buyer lb
         WHERE lb.u_id = ?
         ORDER BY lb.is_default DESC, lb.locb_id ASC`,
        [u_id]
    );
    return rows.map((r) => ({
        ...r,
        latitude: r.latitude == null ? null : Number(r.latitude),
        longitude: r.longitude == null ? null : Number(r.longitude),
        is_default: r.is_default === 1,
    }));
}

/** เพิ่มที่อยู่ใหม่ — ถ้า is_default=true จะ reset ที่อยู่อื่นก่อน */
export async function addMyAddress(u_id: number, data: AddAddressInput): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        if (data.is_default) {
            // reset ที่อยู่อื่นทั้งหมดก่อนตั้งอันใหม่เป็น default
            await conn.query("UPDATE Locations_buyer SET is_default = 0 WHERE u_id = ?", [u_id]);
        }
        await conn.query("INSERT INTO Locations_buyer SET ?", [{
            u_id,
            ...data,
            provinces_id: null,
            districts_id: null,
            subdistricts_id: null,
            is_default: data.is_default ? 1 : 0,
        }]);
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/** ตั้งที่อยู่นี้เป็นที่อยู่หลัก (ตรวจสอบว่าเป็นของ user คนนี้ก่อน) */
export async function setDefaultAddress(u_id: number, locb_id: number): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query<RowDataPacket[]>(
            "SELECT locb_id FROM Locations_buyer WHERE locb_id = ? AND u_id = ? LIMIT 1",
            [locb_id, u_id]
        );
        if (!rows[0]) throw new ApiError(404, "ไม่พบที่อยู่นี้");
        await conn.query("UPDATE Locations_buyer SET is_default = 0 WHERE u_id = ?", [u_id]);
        await conn.query("UPDATE Locations_buyer SET is_default = 1 WHERE locb_id = ?", [locb_id]);
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/** อัปเดตข้อมูลที่อยู่ — ตรวจสอบว่าเป็นของ user คนนี้ก่อน */
export async function updateMyAddress(
    u_id: number,
    locb_id: number,
    data: AddAddressInput
): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query<RowDataPacket[]>(
            "SELECT locb_id FROM Locations_buyer WHERE locb_id = ? AND u_id = ? LIMIT 1",
            [locb_id, u_id]
        );
        if (!rows[0]) throw new ApiError(404, "ไม่พบที่อยู่นี้");

        if (data.is_default) {
            await conn.query("UPDATE Locations_buyer SET is_default = 0 WHERE u_id = ?", [u_id]);
        }
        await conn.query(
            `UPDATE Locations_buyer
             SET locb_recipient_name = ?, locb_phone = ?, locb_address = ?,
                 country_code = ?, state = ?, city = ?, municipality = ?, colonia = ?,
                 provinces_id = NULL, districts_id = NULL, subdistricts_id = NULL,
                 zip_code = ?, latitude = ?, longitude = ?, formatted_address = ?, is_default = ?
             WHERE locb_id = ?`,
            [
                data.locb_recipient_name, data.locb_phone, data.locb_address,
                data.country_code, data.state, data.city, data.municipality, data.colonia,
                data.zip_code, data.latitude, data.longitude, data.formatted_address,
                data.is_default ? 1 : 0,
                locb_id,
            ]
        );
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/** ลบที่อยู่ — ไม่อนุญาตลบที่อยู่หลัก */
export async function deleteAddress(u_id: number, locb_id: number): Promise<void> {
    const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT locb_id, is_default FROM Locations_buyer WHERE locb_id = ? AND u_id = ? LIMIT 1",
        [locb_id, u_id]
    );
    const addr = rows[0];
    if (!addr) throw new ApiError(404, "ไม่พบที่อยู่นี้");
    if (addr.is_default) throw new ApiError(400, "ไม่สามารถลบที่อยู่หลักได้ กรุณาตั้งที่อยู่อื่นเป็นหลักก่อน");
    await pool.query("DELETE FROM Locations_buyer WHERE locb_id = ?", [locb_id]);
}

// ─── Google / Facebook OAuth ─────────────────────────────────────────────────

export async function googleAuth(accessToken: string): Promise<AuthResult> {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) throw new ApiError(401, "access_token ไม่ถูกต้องหรือหมดอายุ");

    const gUser = (await res.json()) as GoogleUserInfo;

    const [existing] = await pool.query<(RowDataPacket & RegisterBuyerDTO)[]>(
        "SELECT u_id, u_username, u_email, u_avatar, u_create_at FROM Users WHERE u_email = ? OR u_provider_id = ? LIMIT 1",
        [gUser.email, gUser.id]
    );

    if (existing[0]) {
        await pool.query("UPDATE Users SET u_last_login = ? WHERE u_id = ?", [new Date(), existing[0].u_id]);
        return { user: existing[0], isNew: false };
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const userData = {
            u_username: gUser.name,
            u_email: gUser.email,
            u_password: null,
            u_provider: "GOOGLE",
            u_provider_id: gUser.id,
            u_avatar: gUser.picture,
            u_email_verified: 1,
            u_create_at: new Date(),
            u_last_login: new Date(),
        };

        const [result] = await conn.query<ResultSetHeader>("INSERT INTO Users SET ?", [userData]);
        await conn.commit();

        const [newRows] = await conn.query<(RowDataPacket & RegisterBuyerDTO)[]>(
            "SELECT u_id, u_username, u_email, u_avatar, u_create_at FROM Users WHERE u_id = ?",
            [result.insertId]
        );

        if (!newRows[0]) throw new ApiError(500, "เกิดข้อผิดพลาดในการบันทึกข้อมูล");
        return { user: newRows[0], isNew: true };
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, UserMessages.repeatEmail);
        throw err;
    } finally {
        conn.release();
    }
}
