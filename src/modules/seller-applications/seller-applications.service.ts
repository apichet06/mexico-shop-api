import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import type {
    OAuthProfile,
    SellerApplicationAccountDTO,
    SellerApplicationDTO,
    SellerApplicationSession,
} from "./seller-applications.type.js";

type RawApplicationRow = RowDataPacket & Omit<SellerApplicationDTO, "completed_steps_json" | "payload_json"> & {
    completed_steps_json: string | number[] | null;
    payload_json: string | Record<string, unknown> | null;
};

function parseJson<T>(value: string | T | null): T | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

function mapApplication(row: RawApplicationRow): SellerApplicationDTO {
    return {
        ...row,
        completed_steps_json: parseJson<number[]>(row.completed_steps_json),
        payload_json: parseJson<Record<string, unknown>>(row.payload_json),
    };
}

async function resetApplicationIfStoreWasDeleted(application: SellerApplicationDTO): Promise<SellerApplicationDTO> {
    if (!application.is_finalized || !application.created_store_id) return application;

    const [storeRows] = await pool.query<RowDataPacket[]>(
        `SELECT st_id FROM Store WHERE st_id = ? LIMIT 1`,
        [application.created_store_id],
    );
    if (storeRows.length > 0) return application;

    await pool.query(
        `UPDATE seller_applications
         SET current_step = 1,
             completed_steps_json = JSON_ARRAY(),
             payload_json = JSON_OBJECT(),
             is_finalized = 0,
             finalized_at = NULL,
             created_store_id = NULL,
             updated_at = ?
         WHERE id = ?`,
        [new Date(), application.id],
    );

    const [rows] = await pool.query<RawApplicationRow[]>(
        `SELECT * FROM seller_applications WHERE id = ? LIMIT 1`,
        [application.id],
    );
    return rows[0] ? mapApplication(rows[0]) : application;
}

async function getAccountByProvider(provider: string, providerUserId: string): Promise<SellerApplicationAccountDTO | null> {
    const [rows] = await pool.query<(RowDataPacket & SellerApplicationAccountDTO)[]>(
        `SELECT * FROM seller_application_accounts WHERE provider = ? AND provider_user_id = ? LIMIT 1`,
        [provider, providerUserId],
    );
    return rows[0] ?? null;
}

async function getApplicationByAccountId(accountId: number): Promise<SellerApplicationDTO | null> {
    const [rows] = await pool.query<RawApplicationRow[]>(
        `SELECT * FROM seller_applications WHERE account_id = ? LIMIT 1`,
        [accountId],
    );
    return rows[0] ? resetApplicationIfStoreWasDeleted(mapApplication(rows[0])) : null;
}

export async function getApplicationSession(applicationId: number, accountId: number): Promise<SellerApplicationSession> {
    const [accountRows] = await pool.query<(RowDataPacket & SellerApplicationAccountDTO)[]>(
        `SELECT * FROM seller_application_accounts WHERE id = ? LIMIT 1`,
        [accountId],
    );
    const account = accountRows[0];
    if (!account) throw new ApiError(404, "ไม่พบข้อมูลบัญชีสมัครผู้ขาย");

    const [applicationRows] = await pool.query<RawApplicationRow[]>(
        `SELECT * FROM seller_applications WHERE id = ? AND account_id = ? LIMIT 1`,
        [applicationId, accountId],
    );
    const application = applicationRows[0] ? await resetApplicationIfStoreWasDeleted(mapApplication(applicationRows[0])) : null;
    if (!application) throw new ApiError(404, "ไม่พบข้อมูลใบสมัครผู้ขาย");

    return { account, application };
}

export async function findOrCreateApplication(profile: OAuthProfile): Promise<SellerApplicationSession> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        let account = await getAccountByProvider(profile.provider, profile.provider_user_id);
        if (account) {
            await conn.query(
                `UPDATE seller_application_accounts
                 SET email = ?, email_verified = ?, display_name = ?, avatar_url = ?, last_login_at = ?
                 WHERE id = ?`,
                [
                    profile.email,
                    profile.email_verified ? 1 : 0,
                    profile.display_name,
                    profile.avatar_url,
                    new Date(),
                    account.id,
                ],
            );
        } else {
            const [result] = await conn.query<ResultSetHeader>(
                `INSERT INTO seller_application_accounts
                    (provider, provider_user_id, email, email_verified, display_name, avatar_url, created_at, last_login_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    profile.provider,
                    profile.provider_user_id,
                    profile.email,
                    profile.email_verified ? 1 : 0,
                    profile.display_name,
                    profile.avatar_url,
                    new Date(),
                    new Date(),
                ],
            );
            account = {
                id: result.insertId,
                provider: profile.provider,
                provider_user_id: profile.provider_user_id,
                email: profile.email,
                email_verified: profile.email_verified ? 1 : 0,
                display_name: profile.display_name,
                avatar_url: profile.avatar_url,
                created_at: new Date().toISOString(),
                last_login_at: new Date().toISOString(),
            };
        }

        let application = await getApplicationByAccountId(account.id);
        if (!application) {
            const [result] = await conn.query<ResultSetHeader>(
                `INSERT INTO seller_applications
                    (account_id, current_step, completed_steps_json, payload_json, is_finalized, created_at)
                 VALUES (?, 1, JSON_ARRAY(), JSON_OBJECT(), 0, ?)`,
                [account.id, new Date()],
            );
            application = {
                id: result.insertId,
                account_id: account.id,
                current_step: 1,
                completed_steps_json: [],
                payload_json: {},
                is_finalized: 0,
                finalized_at: null,
                created_store_id: null,
                created_at: new Date().toISOString(),
                updated_at: null,
            };
        }

        await conn.commit();
        return await getApplicationSession(application.id, account.id);
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

export async function saveApplicationStep(input: {
    applicationId: number;
    accountId: number;
    step: number;
    stepKey: string;
    data: Record<string, unknown>;
    nextStep?: number;
}): Promise<SellerApplicationDTO> {
    const session = await getApplicationSession(input.applicationId, input.accountId);
    if (session.application.is_finalized) {
        throw new ApiError(400, "ใบสมัครนี้สร้างร้านแล้ว ไม่สามารถแก้ไข draft ได้");
    }

    const payload = {
        ...(session.application.payload_json ?? {}),
        [input.stepKey]: input.data,
    };
    const completed = Array.from(new Set([...(session.application.completed_steps_json ?? []), input.step])).sort((a, b) => a - b);
    const currentStep = input.nextStep ?? Math.max(session.application.current_step, input.step);

    await pool.query(
        `UPDATE seller_applications
         SET current_step = ?, completed_steps_json = ?, payload_json = ?
         WHERE id = ? AND account_id = ?`,
        [
            currentStep,
            JSON.stringify(completed),
            JSON.stringify(payload),
            input.applicationId,
            input.accountId,
        ],
    );

    const updated = await getApplicationSession(input.applicationId, input.accountId);
    return updated.application;
}

export async function finalizeApplication(input: {
    applicationId: number;
    accountId: number;
    storeId: number;
    payload?: Record<string, unknown>;
}): Promise<SellerApplicationDTO> {
    const session = await getApplicationSession(input.applicationId, input.accountId);
    if (session.application.is_finalized) {
        throw new ApiError(400, "ใบสมัครนี้สร้างร้านแล้ว");
    }

    const payload = input.payload
        ? { ...(session.application.payload_json ?? {}), ...input.payload }
        : session.application.payload_json;

    await pool.query(
        `UPDATE seller_applications
         SET is_finalized = 1, finalized_at = ?, created_store_id = ?, payload_json = ?
         WHERE id = ? AND account_id = ?`,
        [
            new Date(),
            input.storeId,
            JSON.stringify(payload ?? {}),
            input.applicationId,
            input.accountId,
        ],
    );

    const updated = await getApplicationSession(input.applicationId, input.accountId);
    return updated.application;
}

export async function verifyGoogleAccessToken(accessToken: string): Promise<OAuthProfile> {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new ApiError(401, "Google token ไม่ถูกต้องหรือหมดอายุ");
    const data = await res.json() as {
        id?: string;
        email?: string;
        verified_email?: boolean;
        name?: string;
        picture?: string;
    };
    if (!data.id) throw new ApiError(401, "ไม่พบข้อมูลบัญชี Google");
    return {
        provider: "GOOGLE",
        provider_user_id: data.id,
        email: data.email ?? null,
        email_verified: Boolean(data.verified_email),
        display_name: data.name ?? null,
        avatar_url: data.picture ?? null,
    };
}

export async function verifyFacebookAccessToken(accessToken: string): Promise<OAuthProfile> {
    const res = await fetch(
        `https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${encodeURIComponent(accessToken)}`,
    );
    if (!res.ok) throw new ApiError(401, "Facebook token ไม่ถูกต้องหรือหมดอายุ");
    const data = await res.json() as {
        id?: string;
        name?: string;
        email?: string;
        picture?: { data?: { url?: string } };
    };
    if (!data.id) throw new ApiError(401, "ไม่พบข้อมูลบัญชี Facebook");
    return {
        provider: "FACEBOOK",
        provider_user_id: data.id,
        email: data.email ?? null,
        email_verified: Boolean(data.email),
        display_name: data.name ?? null,
        avatar_url: data.picture?.data?.url ?? null,
    };
}
