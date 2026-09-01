import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import crypto from "crypto";
import type { Request, Response } from "express";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import * as service from "./register-buyer.service.js";
import { UserMessages } from "../../shared/messages/user.messages.js";
import { AuthMessages } from "../../shared/messages/auth.messages.js";
import type { AddAddressInput, RegisterBuyerDTO } from "./type.js";
import { sendBuyerPasswordResetEmail } from "../../mailer/mailer.js";

const ACCESS_TOKEN_EXPIRES_IN = "30m";
const PASSWORD_RESET_EXPIRES_MINUTES = 30;
const FORGOT_PASSWORD_MESSAGE = "Si este correo está registrado, te hemos enviado un enlace para restablecer tu contraseña.";
const REGISTER_FIELD_LIMITS = {
    u_username: 50,
    u_email: 254,
    u_password: 72,
    locb_recipient_name: 100,
    locb_address: 255,
    colonia: 160,
    municipality: 120,
    city: 120,
    state: 100,
    formatted_address: 500,
} as const;

function parseMexicoAddress(body: Record<string, unknown>): AddAddressInput {
    const requiredText = (field: keyof typeof REGISTER_FIELD_LIMITS): string => {
        const value = body[field];
        const maxLength = REGISTER_FIELD_LIMITS[field];
        if (typeof value !== "string" || !value.trim()) {
            throw new ApiError(400, `Ingresa ${field}`);
        }
        if (value.length > maxLength) {
            throw new ApiError(400, `${field} no debe superar los ${maxLength} caracteres`);
        }
        return value.trim();
    };

    const locb_phone = String(body.locb_phone ?? "");
    const zip_code = String(body.zip_code ?? "");
    if (!/^\d{10}$/.test(locb_phone)) {
        throw new ApiError(400, "El número de teléfono mexicano debe tener 10 dígitos.");
    }
    if (!/^\d{5}$/.test(zip_code)) {
        throw new ApiError(400, "El código postal mexicano debe tener 5 dígitos.");
    }
    if (body.country_code !== "MX") {
        throw new ApiError(400, "Solo se admiten direcciones dentro de México.");
    }

    const latitude = body.latitude == null ? null : Number(body.latitude);
    const longitude = body.longitude == null ? null : Number(body.longitude);
    if (latitude !== null && (!Number.isFinite(latitude) || latitude < 14 || latitude > 33)) {
        throw new ApiError(400, "La coordenada de latitud está fuera de México.");
    }
    if (longitude !== null && (!Number.isFinite(longitude) || longitude < -119 || longitude > -86)) {
        throw new ApiError(400, "La coordenada de longitud está fuera de México.");
    }

    const rawFormattedAddress = body.formatted_address;
    if (rawFormattedAddress != null && (
        typeof rawFormattedAddress !== "string"
        || rawFormattedAddress.length > REGISTER_FIELD_LIMITS.formatted_address
    )) {
        throw new ApiError(400, `formatted_address no debe superar los ${REGISTER_FIELD_LIMITS.formatted_address} caracteres`);
    }

    return {
        locb_recipient_name: requiredText("locb_recipient_name"),
        locb_phone,
        locb_address: requiredText("locb_address"),
        colonia: requiredText("colonia"),
        municipality: requiredText("municipality"),
        city: requiredText("city"),
        state: requiredText("state"),
        zip_code,
        country_code: "MX",
        latitude,
        longitude,
        formatted_address: typeof rawFormattedAddress === "string" ? rawFormattedAddress.trim() || null : null,
        is_default: body.is_default === true,
    };
}

function hashResetToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function signAccessToken(user: RegisterBuyerDTO): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new ApiError(500, AuthMessages.secret);

    // access token อายุสั้น ถ้าหมดอายุ frontend จะใช้ refresh cookie ขอ token ใหม่อัตโนมัติ
    return jwt.sign(
        { userId: user.u_id, userEmail: user.u_email, username: user.u_username },
        secret,
        { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
    );
}

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
    if (!cookieHeader) return null;
    const cookies = cookieHeader.split(";").map((item) => item.trim());
    const target = cookies.find((item) => item.startsWith(`${name}=`));
    if (!target) return null;
    return decodeURIComponent(target.slice(name.length + 1));
}

function shouldUseCrossSiteCookie(req: Request): boolean {
    const origin = req.get("origin");
    if (!origin) return process.env.NODE_ENV === "production";

    try {
        const originUrl = new URL(origin);
        const requestProtocol = req.protocol;
        const requestHost = req.get("host") ?? "";

        // dev ของเราอาจเป็น https://localhost:3000 -> http://localhost:5000
        // browser มองว่า cross-site เพราะ scheme ต่างกัน จึงต้องใช้ SameSite=None; Secure
        return originUrl.protocol.replace(":", "") !== requestProtocol || originUrl.host !== requestHost;
    } catch {
        return process.env.NODE_ENV === "production";
    }
}

function refreshCookieOptions(req: Request) {
    const crossSite = shouldUseCrossSiteCookie(req);
    return {
        httpOnly: true,
        secure: crossSite || process.env.NODE_ENV === "production",
        sameSite: crossSite ? "none" as const : "lax" as const,
        path: "/api/auth",
    };
}

function setRefreshCookie(req: Request, res: Response, refreshToken: string) {
    // refresh token เก็บใน httpOnly cookie เพื่อไม่ให้ JavaScript อ่าน token อายุยาวตัวนี้ได้
    res.cookie(service.refreshTokenConfig.cookieName, refreshToken, {
        ...refreshCookieOptions(req),
        maxAge: service.refreshTokenConfig.maxAgeMs,
    });
}

function clearRefreshCookie(req: Request, res: Response) {
    res.clearCookie(service.refreshTokenConfig.cookieName, {
        ...refreshCookieOptions(req),
    });
}

async function sendAuthResponse(
    req: Request,
    res: Response,
    status: number,
    user: RegisterBuyerDTO
) {
    const refreshToken = await service.createRefreshTokenSession({
        u_id: user.u_id,
        user_agent: req.get("user-agent") ?? null,
        ip_address: req.ip ?? null,
    });
    setRefreshCookie(req, res, refreshToken);
    res.status(status).json({ token: signAccessToken(user), user });
}

export const register = asyncHandler(async (req, res) => {
    const {
        u_username,
        u_email,
        u_password,
        u_birthday,
        u_gender,
        u_provider,
        locb_recipient_name,
        locb_phone,
        locb_address,
        colonia,
        municipality,
        city,
        state,
        zip_code,
        country_code,
        latitude,
        longitude,
        formatted_address,
        is_default,
    } = req.body ?? {};

    if (!u_username || !u_email || !u_password) {
        throw new ApiError(400, UserMessages.requiredFields);
    }

    const requestFields: Record<string, unknown> = {
        u_username,
        u_email,
        u_password,
        locb_recipient_name,
        locb_address,
        colonia,
        municipality,
        city,
        state,
        formatted_address,
    };
    for (const [field, maxLength] of Object.entries(REGISTER_FIELD_LIMITS)) {
        const value = requestFields[field];
        if (value != null && (typeof value !== "string" || value.length > maxLength)) {
            throw new ApiError(400, `${field} debe ser texto y no superar los ${maxLength} caracteres`);
        }
    }

    if (!locb_recipient_name || !locb_phone || !locb_address || !colonia || !municipality || !city || !state || !zip_code) {
        throw new ApiError(400, "Debes proporcionar la información de la dirección de envío en México.");
    }
    if (country_code !== "MX") throw new ApiError(400, "Solo se admiten direcciones dentro de México.");
    if (!/^\d{10}$/.test(String(locb_phone))) throw new ApiError(400, "El número de teléfono mexicano debe tener 10 dígitos.");
    if (!/^\d{5}$/.test(String(zip_code))) throw new ApiError(400, "El código postal debe tener 5 dígitos.");

    const parsedLatitude = latitude == null ? null : Number(latitude);
    const parsedLongitude = longitude == null ? null : Number(longitude);
    if (parsedLatitude !== null && (!Number.isFinite(parsedLatitude) || parsedLatitude < 14 || parsedLatitude > 33)) {
        throw new ApiError(400, "La coordenada de latitud está fuera de México.");
    }
    if (parsedLongitude !== null && (!Number.isFinite(parsedLongitude) || parsedLongitude < -119 || parsedLongitude > -86)) {
        throw new ApiError(400, "La coordenada de longitud está fuera de México.");
    }

    const user = await service.registerBuyer({
        u_username,
        u_email,
        u_password,
        u_birthday: u_birthday ?? null,
        u_gender: u_gender ?? null,
        u_provider: u_provider ?? "LOCAL",
        locb_recipient_name,
        locb_phone: String(locb_phone),
        locb_address,
        colonia,
        municipality,
        city,
        state,
        zip_code: String(zip_code),
        country_code,
        latitude: parsedLatitude,
        longitude: parsedLongitude,
        formatted_address: formatted_address || null,
        is_default: is_default ?? false,
    });

    await sendAuthResponse(req, res, 201, user);
});

export const login = asyncHandler(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) throw new ApiError(400, "Debes proporcionar email y password.");

    const user = await service.loginBuyer(email, password);

    await sendAuthResponse(req, res, 200, user);
});

export const facebookLogin = asyncHandler(async (req, res) => {
    const { access_token } = req.body ?? {};
    if (!access_token) throw new ApiError(400, "Debes proporcionar access_token.");

    const { user, isNew } = await service.facebookAuth(access_token);

    await sendAuthResponse(req, res, isNew ? 201 : 200, user);
});

export const refresh = asyncHandler(async (req, res) => {
    const refreshToken = parseCookie(req.headers.cookie, service.refreshTokenConfig.cookieName);
    if (!refreshToken) throw new ApiError(401, "No se encontró el refresh token. Vuelve a iniciar sesión.");

    // หมุน refresh token ทุกครั้งที่ใช้ เพื่อลดความเสี่ยงถ้า token เก่าหลุดออกไป
    const result = await service.rotateRefreshToken(refreshToken, {
        user_agent: req.get("user-agent") ?? null,
        ip_address: req.ip ?? null,
    });
    setRefreshCookie(req, res, result.refreshToken);
    res.status(200).json({ token: signAccessToken(result.user), user: result.user });
});

export const logout = asyncHandler(async (req, res) => {
    const refreshToken = parseCookie(req.headers.cookie, service.refreshTokenConfig.cookieName);
    if (refreshToken) await service.revokeRefreshToken(refreshToken);
    clearRefreshCookie(req, res);
    res.status(200).json({ message: "Sesión cerrada con éxito." });
});

export const forgotPassword = asyncHandler(async (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!email) {
        throw new ApiError(400, "Ingresa tu correo electrónico.");
    }

    const user = await service.findPasswordResetBuyerByEmail(email);
    const shopUrl = process.env.ARCANA_SHOP_URL?.trim()
        || process.env.SHOP_URL?.trim()
        || process.env.FRONTEND_URL?.trim()
        || req.get("origin")?.trim();

    if (user && (user.u_provider !== "LOCAL" || user.has_password !== 1)) {
        const provider = user.u_provider === "GOOGLE" || user.u_provider === "FACEBOOK" ? user.u_provider : "SOCIAL";
        const providerLabel = provider === "GOOGLE" ? "Google" : provider === "FACEBOOK" ? "Facebook" : "Social Login";
        return res.status(200).json({
            status: "oauth_account",
            provider,
            message: `Este correo inicia sesión con ${providerLabel}. Vuelve a iniciar sesión con ${providerLabel}.`,
        });
    }

    if (user && shopUrl) {
        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = hashResetToken(token);
        const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRES_MINUTES * 60 * 1000);

        await service.createPasswordResetToken({
            u_id: user.u_id,
            tokenHash,
            expiresAt,
            requestIp: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
        });

        const resetUrl = `${shopUrl.replace(/\/+$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
        await sendBuyerPasswordResetEmail({
            email: user.u_email,
            name: user.u_username,
            resetUrl,
            expiresInMinutes: PASSWORD_RESET_EXPIRES_MINUTES,
        });
    } else if (user && !shopUrl) {
        console.warn("[buyer forgot-password] skipped email: ARCANA_SHOP_URL, SHOP_URL, FRONTEND_URL, and request origin are missing");
    }

    res.status(200).json({ status: "reset_email_sent", message: FORGOT_PASSWORD_MESSAGE });
});

export const resetPassword = asyncHandler(async (req, res) => {
    const token = String(req.body?.token ?? "").trim();
    const password = String(req.body?.password ?? "");
    const confirmPassword = String(req.body?.confirmPassword ?? req.body?.confirm_password ?? "");

    if (!token || !password || !confirmPassword) {
        throw new ApiError(400, "Faltan datos por completar.");
    }
    if (password !== confirmPassword) {
        throw new ApiError(400, "La nueva contraseña y la confirmación no coinciden.");
    }
    if (password.length < 8) {
        throw new ApiError(400, "La contraseña debe tener al menos 8 caracteres.");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await service.resetPasswordWithToken(hashResetToken(token), hashedPassword);

    res.status(200).json({ message: "Contraseña restablecida con éxito. Vuelve a iniciar sesión." });
});

// ─── Profile ────────────────────────────────────────────────────────────────

export const getMe = asyncHandler(async (req, res) => {
    const data = await service.getMyProfile(req.userId!);
    res.status(200).json({ data });
});

export const updateMe = asyncHandler(async (req, res) => {
    const { u_username, u_birthday, u_gender } = req.body ?? {};
    if (!u_username) throw new ApiError(400, "Ingresa tu nombre de usuario.");

    const data = await service.updateMyProfile(req.userId!, {
        u_username,
        u_birthday: u_birthday ?? null,
        u_gender: u_gender ?? null,
    });
    res.status(200).json({ data });
});

// ─── Password ────────────────────────────────────────────────────────────────

export const changePassword = asyncHandler(async (req, res) => {
    const { current_password, new_password, confirm_password } = req.body ?? {};

    if (!current_password || !new_password || !confirm_password) {
        throw new ApiError(400, "Completa toda la información.");
    }
    if (new_password !== confirm_password) {
        throw new ApiError(400, "La nueva contraseña y la confirmación no coinciden.");
    }
    if (new_password.length < 8) {
        throw new ApiError(400, "La nueva contraseña debe tener al menos 8 caracteres.");
    }

    await service.changePassword(req.userId!, current_password, new_password);
    res.status(200).json({ message: "Contraseña actualizada con éxito." });
});

// ─── Addresses ──────────────────────────────────────────────────────────────

export const getAddresses = asyncHandler(async (req, res) => {
    const data = await service.getMyAddresses(req.userId!);
    res.status(200).json({ data });
});

export const addAddress = asyncHandler(async (req, res) => {
    await service.addMyAddress(req.userId!, parseMexicoAddress(req.body ?? {}));
    res.status(201).json({ message: "Dirección agregada con éxito." });
});

export const updateAddress = asyncHandler(async (req, res) => {
    const locb_id = Number(req.params.id);
    if (!Number.isInteger(locb_id) || locb_id <= 0) {
        throw new ApiError(400, "El ID de la dirección no es válido.");
    }
    await service.updateMyAddress(req.userId!, locb_id, parseMexicoAddress(req.body ?? {}));
    res.status(200).json({ message: "Dirección actualizada con éxito." });
});

export const setDefaultAddress = asyncHandler(async (req, res) => {
    const locb_id = Number(req.params.id);
    await service.setDefaultAddress(req.userId!, locb_id);
    res.status(200).json({ message: "Dirección establecida como principal con éxito." });
});

export const deleteAddress = asyncHandler(async (req, res) => {
    const locb_id = Number(req.params.id);
    await service.deleteAddress(req.userId!, locb_id);
    res.status(200).json({ message: "Dirección eliminada con éxito." });
});

// ─── OAuth ───────────────────────────────────────────────────────────────────

export const googleLogin = asyncHandler(async (req, res) => {
    const { access_token } = req.body ?? {};
    if (!access_token) throw new ApiError(400, "Debes proporcionar access_token.");

    const { user, isNew } = await service.googleAuth(access_token);

    await sendAuthResponse(req, res, isNew ? 201 : 200, user);
});
