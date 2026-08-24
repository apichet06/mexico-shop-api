import jwt from "jsonwebtoken";
import type { Request } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { ApiError } from "../../shared/errors/ApiError.js";
import * as service from "./seller-applications.service.js";
import * as store from "../stores/store.service.js";
import * as empService from "../employees/emp.service.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { cleanupSavedFiles, fileUploadImage } from "../../shared/middlewares/fileUploadImage.js";
import type { SellerApplicationSession, SellerApplicationTokenPayload } from "./seller-applications.type.js";
import { sendEmployeeEmailVerificationEmail, sendStoreEmailVerificationEmail, sendStoreRegistrationEmail } from "../../mailer/mailer.js";

const SELLER_APPLICATION_TOKEN_EXPIRES_IN = "7d";
const SELLER_PDPA_NOTICE_VERSION = "seller-registration-pdpa-v1";

function signSellerApplicationToken(payload: SellerApplicationTokenPayload): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new ApiError(500, "JWT_SECRET is not defined");
    return jwt.sign(payload, secret, { expiresIn: SELLER_APPLICATION_TOKEN_EXPIRES_IN });
}

function hashEmailVerificationToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function buildBackofficeUrl(path: string): string | null {
    const backofficeUrl = process.env.BACKOFFICE_URL?.trim();
    if (!backofficeUrl) return null;
    return `${backofficeUrl.replace(/\/+$/, "")}${path}`;
}

function getBearerToken(req: Request): string {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new ApiError(401, "ไม่พบ seller application token");
    return header.slice("Bearer ".length);
}

function verifySellerApplicationToken(req: Request): SellerApplicationTokenPayload {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new ApiError(500, "JWT_SECRET is not defined");
    try {
        return jwt.verify(getBearerToken(req), secret) as SellerApplicationTokenPayload;
    } catch {
        throw new ApiError(401, "seller application token ไม่ถูกต้องหรือหมดอายุ");
    }
}

async function sendSessionResponse(res: any, session: Awaited<ReturnType<typeof service.findOrCreateApplication>>, status = 200) {
    const token = signSellerApplicationToken({
        sellerApplicationId: session.application.id,
        sellerApplicationAccountId: session.account.id,
    });
    res.status(status).json({ token, data: session });
}

function sendFinalizedStoreRegistrationEmail(session: SellerApplicationSession, source: string): void {
    const storeId = session.application.created_store_id;
    if (!session.application.is_finalized || !storeId) return;

    store.getStoreRegistrationEmailInput(storeId)
        .then((emailInput) => {
            if (!emailInput) return;
            return sendStoreRegistrationEmail(emailInput);
        })
        .catch((error) => {
            console.warn(`[seller-applications] send finalized registration email failed from ${source} for store ${storeId}:`, error);
        });
}

export const googleStart = asyncHandler(async (req, res) => {
    const { access_token } = req.body ?? {};
    if (!access_token) throw new ApiError(400, "จำเป็นต้องระบุ access_token");

    const profile = await service.verifyGoogleAccessToken(access_token);
    const session = await service.findOrCreateApplication(profile);
    sendFinalizedStoreRegistrationEmail(session, "googleStart");
    await sendSessionResponse(res, session);
});

export const facebookStart = asyncHandler(async (req, res) => {
    const { access_token } = req.body ?? {};
    if (!access_token) throw new ApiError(400, "จำเป็นต้องระบุ access_token");

    const profile = await service.verifyFacebookAccessToken(access_token);
    const session = await service.findOrCreateApplication(profile);
    sendFinalizedStoreRegistrationEmail(session, "facebookStart");
    await sendSessionResponse(res, session);
});

export const me = asyncHandler(async (req, res) => {
    const payload = verifySellerApplicationToken(req);
    const session = await service.getApplicationSession(
        payload.sellerApplicationId,
        payload.sellerApplicationAccountId,
    );
    res.status(200).json({ data: session });
});

export const saveStep = asyncHandler(async (req, res) => {
    const payload = verifySellerApplicationToken(req);
    const { step, step_key, data, next_step } = req.body ?? {};

    if (!step || !step_key || typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new ApiError(400, "ข้อมูล step ไม่ครบถ้วน");
    }

    const saveInput: Parameters<typeof service.saveApplicationStep>[0] = {
        applicationId: payload.sellerApplicationId,
        accountId: payload.sellerApplicationAccountId,
        step: Number(step),
        stepKey: String(step_key),
        data,
    };
    if (next_step) saveInput.nextStep = Number(next_step);

    const application = await service.saveApplicationStep(saveInput);

    res.status(200).json({ data: application });
});

export const finalizeRegister = asyncHandler(async (req, res) => {
    const payload = verifySellerApplicationToken(req);
    const savedPaths: string[] = [];

    try {
        const session = await service.getApplicationSession(
            payload.sellerApplicationId,
            payload.sellerApplicationAccountId,
        );
        if (session.application.is_finalized) {
            throw new ApiError(400, "ใบสมัครนี้สร้างร้านแล้ว");
        }
        if (req.body.pdpa_accepted !== "true") {
            throw new ApiError(400, "กรุณายอมรับนโยบายความเป็นส่วนตัวและเงื่อนไขก่อนส่งใบสมัคร");
        }

        const files = req.files as {
            st_image?: Express.Multer.File[];
            doc_VAT_CERT?: Express.Multer.File[];
            doc_COMPANY_CERT?: Express.Multer.File[];
            doc_ID_CARD?: Express.Multer.File[];
            doc_OTHER?: Express.Multer.File[];
        };

        const locations = JSON.parse(req.body.locations ?? "[]");
        const employees = JSON.parse(req.body.employees ?? "[]");
        const documentsMeta = JSON.parse(req.body.documents_meta ?? "[]");
        if (!Array.isArray(employees) || employees.length !== 1 || employees[0]?.e_status !== "Owner") {
            throw new ApiError(400, "การสมัครผู้ขายต้องมี Primary Owner เพียง 1 คน");
        }

        let stImagePath: string | null = null;
        const stImageFile = files?.st_image?.[0];
        if (stImageFile) {
            const movedPath = await fileUploadImage(stImageFile, `store_${Date.now()}`, "store");
            stImagePath = movedPath;
            savedPaths.push(movedPath);
        }

        const documents = await Promise.all(
            documentsMeta.map(async (meta: { doc_type: string }) => {
                const fieldKey = `doc_${meta.doc_type}` as keyof typeof files;
                const docFiles = files?.[fieldKey] ?? [];

                const uploadedFiles = await Promise.all(
                    docFiles.map(async (file, idx) => {
                        const fixedOriginalName = Buffer.from(file.originalname, "latin1").toString("utf8");
                        const movedPath = await fileUploadImage(file, `${meta.doc_type}_${Date.now()}_${idx}`, "documents");
                        savedPaths.push(movedPath);

                        return {
                            file_path: movedPath,
                            original_name: fixedOriginalName,
                            mime_type: file.mimetype,
                            size: file.size,
                        };
                    }),
                );

                return {
                    doc_type: meta.doc_type,
                    files: uploadedFiles,
                };
            }),
        );

        const employeesWithPassword = await Promise.all(employees.map(async (emp: any) => {
            if (!emp.e_password || String(emp.e_password).length < 8) {
                throw new ApiError(400, "ผู้ใช้งานร้านทุกคนต้องตั้งรหัสผ่านอย่างน้อย 8 ตัวอักษร");
            }

            const password = String(emp.e_password);
            const hashedPassword = await bcrypt.hash(password, 10);
            const { e_password, e_password_confirm, ...employee } = emp;

            return {
                ...employee,
                e_password: hashedPassword,
            };
        }));

        const storeId = await store.createStoreRegister({
            st_company_name: req.body.st_company_name,
            st_email: req.body.st_email,
            st_phone: req.body.st_phone,
            st_image: stImagePath,
            bk_id: Number(req.body.bk_id),
            bank_account_number: req.body.bank_account_number,
            tax_seller_type: req.body.tax_seller_type,
            st_idcard: req.body.st_idcard,
            st_status: req.body.st_status,
            is_platform_store: false,
            legal_name: req.body.legal_name,
            tax_id_number: req.body.tax_id_number,
            is_vat_registered: req.body.is_vat_registered === "true",
            branch_type: req.body.branch_type || null,
            branch_code: req.body.branch_code || null,
            tax_address: req.body.tax_address,
            tax_province_id: Number(req.body.tax_province_id),
            tax_district_id: Number(req.body.tax_district_id),
            tax_subdistrict_id: Number(req.body.tax_subdistrict_id),
            tax_zip_code: req.body.tax_zip_code,
            locations,
            employees: employeesWithPassword,
            documents,
            st_id: 0,
        });

        const application = await service.finalizeApplication({
            applicationId: payload.sellerApplicationId,
            accountId: payload.sellerApplicationAccountId,
            storeId,
            payload: {
                store: {
                    st_company_name: req.body.st_company_name,
                    st_email: req.body.st_email,
                    st_phone: req.body.st_phone,
                    bk_id: Number(req.body.bk_id),
                    bank_account_number: req.body.bank_account_number,
                },
                employees: {
                    employees: employeesWithPassword.map(({ e_password, ...employee }: any) => employee),
                },
                consent: {
                    pdpa_accepted: true,
                    pdpa_accepted_at: new Date().toISOString(),
                    pdpa_notice_version: SELLER_PDPA_NOTICE_VERSION,
                    ip_address: req.ip,
                    user_agent: req.get("user-agent") ?? null,
                },
            },
        });

        store.getStoreRegistrationEmailInput(storeId)
            .then((emailInput) => {
                if (!emailInput) return;
                return sendStoreRegistrationEmail(emailInput);
            })
            .catch((error) => {
                console.warn(`[seller-applications] send registration email failed for store ${storeId}:`, error);
            });

        store.createStoreEmailVerificationInvite({
            stId: storeId,
            createdByEmpId: null,
        }).then((storeEmailInvite) => {
            const verifyUrl = buildBackofficeUrl(`/store-email-confirmation?token=${encodeURIComponent(storeEmailInvite.token)}`);
            if (!verifyUrl) {
                console.warn("[seller-applications] skipped store email verification: BACKOFFICE_URL is missing");
                return;
            }
            return sendStoreEmailVerificationEmail({
                email: storeEmailInvite.email,
                storeName: storeEmailInvite.storeName,
                verifyUrl,
                expiresAt: storeEmailInvite.expiresAt,
            });
        }).catch((error) => {
            console.warn(`[seller-applications] send store email verification failed for store ${storeId}:`, error);
        });

        empService.listEmps(storeId)
            .then(async (createdEmployees) => {
                const ownerEmail = String(employeesWithPassword[0]?.e_email ?? "").trim().toLowerCase();
                const owner = createdEmployees.find((employee) =>
                    employee.e_status === "Owner" &&
                    String(employee.e_email ?? "").trim().toLowerCase() === ownerEmail
                ) ?? createdEmployees.find((employee) => employee.e_status === "Owner");
                if (!owner) return;

                const token = crypto.randomBytes(32).toString("hex");
                const invite = await empService.createEmployeeEmailVerificationInvite({
                    e_id: owner.e_id,
                    tokenHash: hashEmailVerificationToken(token),
                    requiresPasswordSetup: false,
                    requestIp: req.ip ?? null,
                    userAgent: req.get("user-agent") ?? null,
                });
                const verifyUrl = buildBackofficeUrl(`/employee-email-confirmation?token=${encodeURIComponent(token)}`);
                if (!verifyUrl) {
                    console.warn("[seller-applications] skipped owner email verification: BACKOFFICE_URL is missing");
                    return;
                }

                return sendEmployeeEmailVerificationEmail({
                    email: invite.email,
                    name: invite.name,
                    storeName: invite.storeName,
                    role: invite.role,
                    verifyUrl,
                    expiresAt: invite.expiresAt,
                });
            })
            .catch((error) => {
                console.warn(`[seller-applications] send owner email verification failed for store ${storeId}:`, error);
            });

        res.status(201).json({ message: CommonMessages.insertSuccess, id: storeId, data: application });
    } catch (error) {
        cleanupSavedFiles(savedPaths);
        throw error;
    }
});
