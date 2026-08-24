import * as emp from "./emp.service.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import jwt from "jsonwebtoken";
import { fileUploadImage } from "../../shared/middlewares/fileUploadImage.js";
import bcrypt from "bcrypt";
import { AuthMessages } from "../../shared/messages/auth.messages.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import crypto from "crypto";
import { sendEmployeeEmailVerificationEmail, sendEmployeePasswordResetEmail } from "../../mailer/mailer.js";

const PASSWORD_RESET_EXPIRES_MINUTES = 30;
const FORGOT_PASSWORD_MESSAGE = "หากอีเมลนี้อยู่ในระบบ เราได้ส่งลิงก์ตั้งรหัสผ่านใหม่ให้แล้ว";

function hashResetToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function buildBackofficeUrl(path: string): string | null {
    const backofficeUrl = process.env.BACKOFFICE_URL?.trim();
    if (!backofficeUrl) return null;
    return `${backofficeUrl.replace(/\/+$/, "")}${path}`;
}

function employeeDisplayName(employee: { e_firstname?: string | null; e_lastname?: string | null }): string | null {
    return [employee.e_firstname, employee.e_lastname].filter(Boolean).join(" ").trim() || null;
}

function isActiveEmployee(value: unknown): boolean {
    return value === true || value === 1 || value === "1";
}

export const list = asyncHandler(async (_req, res) => {
    const { st_id } = _req.params;
    const data = await emp.listEmps(Number(st_id));
    res.status(200).json({ data });
});


export const login = asyncHandler(async (req, res) => {

    const { email, password } = req.body;
    const employee = await emp.findByEmpLogin(email);
    if (!employee) {
        return res.status(404).json({ message: CommonMessages.notFound });
    }
    if (!employee.e_isActive) {
        return res.status(403).json({ message: AuthMessages.resign });
    }
    if (!employee.e_email_verified_at) {
        return res.status(403).json({ message: AuthMessages.emailNotVerified });
    }
    const isMatch = await bcrypt.compare(password, employee.e_password);
    if (!isMatch) {
        return res.status(400).json({ message: AuthMessages.invalidPassword });
    }
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        throw new Error("JWT_SECRET is not defined(ไม่ได้ถูกกำหนดไว้)");
    }

    const token = jwt.sign({
        empId: employee.e_id,
        empEmail: employee.e_email,
        empStatus: employee.e_status,
        empFirstname: employee.e_firstname,
        storeId: employee.st_id,
        empFullname: `${employee.e_firstname} ${employee.e_lastname}`,
    }, jwtSecret, { expiresIn: '20h' })

    const { e_password, e_phone, e_upd_name, e_add_name, e_add_datetime, ...data } = employee;
    res.status(200).json({ token, data: data });
})

export const forgotPassword = asyncHandler(async (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!email) {
        throw new ApiError(400, "กรุณาระบุอีเมล");
    }

    const employee = await emp.findPasswordResetEmployeeByEmail(email);
    const backofficeUrl = process.env.BACKOFFICE_URL?.trim();

    if (employee && isActiveEmployee(employee.e_isActive) && backofficeUrl) {
        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = hashResetToken(token);
        const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRES_MINUTES * 60 * 1000);
        await emp.createPasswordResetToken({
            e_id: employee.e_id,
            tokenHash,
            expiresAt,
            requestIp: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
        });

        const resetUrl = `${backofficeUrl.replace(/\/+$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
        await sendEmployeePasswordResetEmail({
            email: employee.e_email,
            name: employeeDisplayName(employee),
            resetUrl,
            expiresInMinutes: PASSWORD_RESET_EXPIRES_MINUTES,
        });
    } else if (employee && isActiveEmployee(employee.e_isActive) && !backofficeUrl) {
        console.warn("[forgot-password] skipped email: BACKOFFICE_URL is missing");
    }

    res.status(200).json({ message: FORGOT_PASSWORD_MESSAGE });
});

export const resetPassword = asyncHandler(async (req, res) => {
    const token = String(req.body?.token ?? "").trim();
    const password = String(req.body?.password ?? "");
    const confirmPassword = String(req.body?.confirmPassword ?? req.body?.confirm_password ?? "");

    if (!token || !password || !confirmPassword) {
        throw new ApiError(400, "ข้อมูลไม่ครบถ้วน");
    }
    if (password !== confirmPassword) {
        throw new ApiError(400, "รหัสผ่านใหม่และยืนยันรหัสผ่านไม่ตรงกัน");
    }
    if (password.length < 8) {
        throw new ApiError(400, "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await emp.resetPasswordWithToken(hashResetToken(token), hashedPassword);

    res.status(200).json({ message: "ตั้งรหัสผ่านใหม่สำเร็จ กรุณาเข้าสู่ระบบอีกครั้ง" });
});


export const createFullAdmin = asyncHandler(async (req, res) => {
    const { e_firstname, e_lastname, e_email, e_phone, e_isActive, e_add_name, e_status, st_id } = req.body;
    const temporaryPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
    const employee = { e_firstname, e_lastname, e_password: temporaryPasswordHash, e_email: String(e_email ?? "").trim().toLowerCase(), e_phone, e_isActive: "1", e_add_name, e_status, st_id };
    const employeeId = await emp.CreateEmpAdmins(employee);

    const token = crypto.randomBytes(32).toString("hex");
    const invite = await emp.createEmployeeEmailVerificationInvite({
        e_id: employeeId,
        tokenHash: hashResetToken(token),
        requiresPasswordSetup: true,
        requestIp: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
    });
    const verifyUrl = buildBackofficeUrl(`/employee-email-confirmation?token=${encodeURIComponent(token)}`);
    if (verifyUrl) {
        await sendEmployeeEmailVerificationEmail({
            email: invite.email,
            name: invite.name,
            storeName: invite.storeName,
            role: invite.role,
            verifyUrl,
            expiresAt: invite.expiresAt,
        });
    } else {
        console.warn("[employee-email-verification] skipped email: BACKOFFICE_URL is missing");
    }

    res.status(201).json({ message: CommonMessages.insertSuccess, verification_email: invite.email });

})

export const updatefullAdmin = asyncHandler(async (req, res) => {
    const { e_id } = req.params;
    const { e_firstname, e_lastname, e_email, e_phone, e_isActive, e_upd_name, e_status, st_id } = req.body;
    const current = await emp.findByEmpId(Number(e_id));
    const normalizedEmail = String(e_email ?? "").trim().toLowerCase();
    const emailChanged = Boolean(current && normalizedEmail && normalizedEmail !== current.e_email.trim().toLowerCase());
    const employee = { e_firstname, e_lastname, e_email: normalizedEmail, e_phone, e_isActive, e_upd_name, e_status, st_id };
    await emp.UpdateEmpAdmins(Number(e_id), employee);

    let verificationEmail: string | null = null;
    if (emailChanged) {
        const token = crypto.randomBytes(32).toString("hex");
        const invite = await emp.createEmployeeEmailVerificationInvite({
            e_id: Number(e_id),
            tokenHash: hashResetToken(token),
            requiresPasswordSetup: !current?.e_email_verified_at,
            requestIp: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
        });
        const verifyUrl = buildBackofficeUrl(`/employee-email-confirmation?token=${encodeURIComponent(token)}`);
        if (verifyUrl) {
            await sendEmployeeEmailVerificationEmail({
                email: invite.email,
                name: invite.name,
                storeName: invite.storeName,
                role: invite.role,
                verifyUrl,
                expiresAt: invite.expiresAt,
            });
            verificationEmail = invite.email;
        } else {
            console.warn("[employee-email-verification] skipped email: BACKOFFICE_URL is missing");
        }
    }

    res.status(200).json({ message: CommonMessages.updateSuccess, verification_email: verificationEmail });

})

export const resendEmailVerification = asyncHandler(async (req, res) => {
    const { e_id } = req.params;
    const current = await emp.findByEmpId(Number(e_id));
    const token = crypto.randomBytes(32).toString("hex");
    const invite = await emp.createEmployeeEmailVerificationInvite({
        e_id: Number(e_id),
        tokenHash: hashResetToken(token),
        requiresPasswordSetup: !current?.e_email_verified_at,
        requestIp: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
    });
    const verifyUrl = buildBackofficeUrl(`/employee-email-confirmation?token=${encodeURIComponent(token)}`);
    if (!verifyUrl) {
        throw new ApiError(500, "BACKOFFICE_URL is missing");
    }

    await sendEmployeeEmailVerificationEmail({
        email: invite.email,
        name: invite.name,
        storeName: invite.storeName,
        role: invite.role,
        verifyUrl,
        expiresAt: invite.expiresAt,
    });

    res.status(200).json({ message: "ส่งลิงก์ยืนยันอีเมลสำเร็จ", verification_email: invite.email, expires_at: invite.expiresAt });
});

export const getEmailVerification = asyncHandler(async (req, res) => {
    const { token } = req.params;
    const data = await emp.getEmployeeEmailVerificationSummary(hashResetToken(String(token ?? "")));

    res.status(200).json({
        data: {
            email: data.email,
            name: data.name,
            storeName: data.storeName,
            role: data.role,
            expiresAt: data.expiresAt,
            requiresPasswordSetup: data.requiresPasswordSetup,
        },
    });
});

export const confirmEmailVerification = asyncHandler(async (req, res) => {
    const { token } = req.params;
    const password = String(req.body?.password ?? "");
    const confirmPassword = String(req.body?.confirmPassword ?? req.body?.confirm_password ?? "");
    let passwordHash: string | null = null;

    if (password || confirmPassword) {
        if (password !== confirmPassword) {
            throw new ApiError(400, "รหัสผ่านใหม่และยืนยันรหัสผ่านไม่ตรงกัน");
        }
        if (password.length < 8) {
            throw new ApiError(400, "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
        }
        passwordHash = await bcrypt.hash(password, 10);
    }

    const result = await emp.confirmEmployeeEmail({
        tokenHash: hashResetToken(String(token ?? "")),
        passwordHash,
        requestIp: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
    });

    res.status(200).json({ message: "ยืนยันอีเมลผู้ใช้งานสำเร็จ", data: result });
});

export const changePassword = asyncHandler(async (req, res) => {
    const { e_id } = req.params;
    const { PasswordOld, PasswordNew } = req.body ?? {};
    const employeeId = Number(e_id);

    if (!employeeId || !PasswordOld || !PasswordNew) {
        throw new ApiError(400, "ข้อมูลไม่ครบถ้วน");
    }

    if (Number(req.empId) !== employeeId) {
        throw new ApiError(403, "ไม่มีสิทธิ์เปลี่ยนรหัสผ่านของผู้ใช้นี้");
    }

    const employee = await emp.findByEmpId(employeeId);
    if (!employee) {
        throw new ApiError(404, CommonMessages.notFound);
    }

    const isMatch = await bcrypt.compare(PasswordOld, employee.e_password);
    if (!isMatch) {
        throw new ApiError(400, AuthMessages.passwordNotMatch);
    }

    const hashedPassword = await bcrypt.hash(PasswordNew, 10);
    await emp.updatePassword(employeeId, hashedPassword);

    res.status(200).json({ message: CommonMessages.updateSuccess });
});

export const deleteFullAdmin = asyncHandler(async (req, res) => {
    const { e_id } = req.params;
    await emp.DeleteEmpAdmins(Number(e_id));
    res.status(200).json({ message: CommonMessages.deleteSuccess });
});


export const create = asyncHandler(async (req, res) => {
    const { e_firstname, e_lastname, e_password, e_email, e_phone, e_isActive, e_add_name, e_isAccept, e_status, st_id } = req.body;
    const { st_company_name, _company_name, st_idcard, bank_name, account_number, omise_recipient_id, st_email, created_at, st_phone } = req.body;
    const { loc_name, loc_address, loc_postcode, Subdistricts_id, Districts_id, Provinces_id } = req.body;
    const empId = Number(req.empId);
    const files = req.files as { [key: string]: Express.Multer.File[] };
    // let e_image = null;
    let st_image = null;


    // store image
    if (files?.st_image?.[0]) {
        const file = files.st_image[0];
        const path = await fileUploadImage(file, `store_${Date.now()}`, 'store');
        if (path) {
            st_image = path.replace(/\\/g, '/');
        }
    }

    const employee = { e_firstname, e_lastname, e_password, e_email, e_phone, e_isActive, e_add_name, e_isAccept, e_status, st_id };
    const store = { st_company_name, _company_name, st_idcard, bank_name, account_number, omise_recipient_id, st_email, created_at, st_phone, st_image, e_id: empId };
    const location = { loc_name, loc_address, loc_postcode, Subdistricts_id, Districts_id, Provinces_id };


    await emp.createEmp(store, employee, location);
    res.status(201).json({ message: CommonMessages.insertSuccess });
});


