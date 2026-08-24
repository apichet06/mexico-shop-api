import { ApiError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import * as service from "./coupon.service.js";
import type { CouponDiscountType } from "./type.js";

function requireStoreId(storeId: number | undefined): number {
    if (!storeId) throw new ApiError(401, "ไม่พบข้อมูลร้านค้า");
    return Number(storeId);
}

function requireUserId(userId: number | undefined): number {
    if (!userId) throw new ApiError(401, "ไม่พบข้อมูลผู้ใช้");
    return Number(userId);
}

function parseId(value: unknown, name: string): number {
    if (Array.isArray(value)) throw new ApiError(400, `${name} ไม่ถูกต้อง`);
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, `${name} ไม่ถูกต้อง`);
    return id;
}

function normalizeDiscountType(value: unknown): CouponDiscountType {
    if (value !== "percent" && value !== "amount") {
        throw new ApiError(400, "discount_type ต้องเป็น percent หรือ amount");
    }

    return value;
}

// ตรวจ payload เบื้องต้นที่ controller ก่อนส่งเข้า service ซึ่งจะจัดการ transaction/DB ต่อ
function validateCouponBody(body: Record<string, unknown>, partial = false): void {
    const requiredFields = [
        "co_code",
        "discount_type",
        "discount_value",
        "co_datetime_start",
        "co_datetime_end",
    ];

    if (!partial) {
        for (const field of requiredFields) {
            if (body[field] === undefined || body[field] === null || body[field] === "") {
                throw new ApiError(400, `จำเป็นต้องระบุ ${field}`);
            }
        }
    }

    if (body.discount_type !== undefined) normalizeDiscountType(body.discount_type);

    if (body.discount_value !== undefined && Number(body.discount_value) <= 0) {
        throw new ApiError(400, "discount_value ต้องมากกว่า 0");
    }

    if (body.usage_limit_per_user !== undefined && Number(body.usage_limit_per_user) < 1) {
        throw new ApiError(400, "usage_limit_per_user ต้องมากกว่า 0");
    }

    if (body.usage_limit_total !== undefined && body.usage_limit_total !== null && Number(body.usage_limit_total) < 1) {
        throw new ApiError(400, "usage_limit_total ต้องมากกว่า 0");
    }
}

export const list = asyncHandler(async (req, res) => {
    const stId = requireStoreId(req.storeId);
    const data = await service.listCoupons(stId);
    res.status(200).json({ data });
});

export const available = asyncHandler(async (req, res) => {
    const data = await service.listAvailableCoupons(req.userId);
    res.status(200).json({ data });
});

export const detail = asyncHandler(async (req, res) => {
    const stId = requireStoreId(req.storeId);
    const coId = parseId(req.params.co_id, "co_id");
    const data = await service.getCouponById(coId, stId);

    if (!data) throw new ApiError(404, CommonMessages.notFound);

    res.status(200).json({ data });
});

export const products = asyncHandler(async (req, res) => {
    const stId = requireStoreId(req.storeId);
    const coId = parseId(req.params.co_id, "co_id");
    const data = await service.listCouponProducts(coId, stId);
    res.status(200).json({ data });
});

export const availableProducts = asyncHandler(async (req, res) => {
    const coId = parseId(req.params.co_id, "co_id");
    const data = await service.listAvailableCouponProducts(coId);
    res.status(200).json({ data });
});

export const create = asyncHandler(async (req, res) => {
    const stId = requireStoreId(req.storeId);
    const body = req.body as Record<string, unknown>;
    validateCouponBody(body);

    // st_id มาจาก token พนักงานร้านค้า ไม่รับจาก body เพื่อกันสร้างคูปองข้ามร้าน
    const coId = await service.createCoupon({
        co_code: String(body.co_code).trim(),
        discount_type: normalizeDiscountType(body.discount_type),
        discount_value: Number(body.discount_value),
        max_discount_amount: body.max_discount_amount === undefined || body.max_discount_amount === null
            ? null
            : Number(body.max_discount_amount),
        co_datetime_start: String(body.co_datetime_start),
        co_datetime_end: String(body.co_datetime_end),
        min_order_amount: body.min_order_amount === undefined ? 0 : Number(body.min_order_amount),
        usage_limit_total: body.usage_limit_total === undefined || body.usage_limit_total === null
            ? null
            : Number(body.usage_limit_total),
        usage_limit_per_user: body.usage_limit_per_user === undefined ? 1 : Number(body.usage_limit_per_user),
        active: body.active === undefined ? 1 : Number(body.active),
        st_id: stId,
        product_ids: Array.isArray(body.product_ids) ? body.product_ids.map(Number) : [],
    });

    res.status(201).json({ message: CommonMessages.insertSuccess, data: coId });
});

export const update = asyncHandler(async (req, res) => {
    const stId = requireStoreId(req.storeId);
    const coId = parseId(req.params.co_id, "co_id");
    const body = req.body as Record<string, unknown>;
    validateCouponBody(body, true);

    // ส่งเฉพาะ field ที่มีมาใน body เพื่อรองรับ partial update
    await service.updateCoupon(coId, {
        ...(body.co_code !== undefined ? { co_code: String(body.co_code).trim() } : {}),
        ...(body.discount_type !== undefined ? { discount_type: normalizeDiscountType(body.discount_type) } : {}),
        ...(body.discount_value !== undefined ? { discount_value: Number(body.discount_value) } : {}),
        ...(body.max_discount_amount !== undefined ? {
            max_discount_amount: body.max_discount_amount === null ? null : Number(body.max_discount_amount),
        } : {}),
        ...(body.co_datetime_start !== undefined ? { co_datetime_start: String(body.co_datetime_start) } : {}),
        ...(body.co_datetime_end !== undefined ? { co_datetime_end: String(body.co_datetime_end) } : {}),
        ...(body.min_order_amount !== undefined ? { min_order_amount: Number(body.min_order_amount) } : {}),
        ...(body.usage_limit_total !== undefined ? {
            usage_limit_total: body.usage_limit_total === null ? null : Number(body.usage_limit_total),
        } : {}),
        ...(body.usage_limit_per_user !== undefined ? { usage_limit_per_user: Number(body.usage_limit_per_user) } : {}),
        ...(body.active !== undefined ? { active: Number(body.active) } : {}),
        ...(body.product_ids !== undefined ? {
            product_ids: Array.isArray(body.product_ids) ? body.product_ids.map(Number) : [],
        } : {}),
        st_id: stId,
    });

    res.status(200).json({ message: CommonMessages.updateSuccess });
});

export const remove = asyncHandler(async (req, res) => {
    const stId = requireStoreId(req.storeId);
    const coId = parseId(req.params.co_id, "co_id");

    await service.deleteCoupon(coId, stId);
    res.status(200).json({ message: CommonMessages.deleteSuccess });
});

export const claim = asyncHandler(async (req, res) => {
    const uId = requireUserId(req.userId);
    const coId = parseId(req.params.co_id, "co_id");

    await service.claimCoupon(coId, uId);
    res.status(201).json({ message: "เก็บคูปองสำเร็จ" });
});

export const myCoupons = asyncHandler(async (req, res) => {
    const uId = requireUserId(req.userId);
    const data = await service.listUserCoupons(uId);
    res.status(200).json({ data });
});

export const validate = asyncHandler(async (req, res) => {
    const uId = requireUserId(req.userId);
    const { co_code } = req.body ?? {};

    if (!co_code) throw new ApiError(400, "จำเป็นต้องระบุ co_code");

    // validate endpoint ใช้ให้หน้าตะกร้า preview ยอดลด ก่อนกด checkout จริง
    const data = await service.validateCoupon({
        u_id: uId,
        co_code: String(co_code).trim(),
    });

    res.status(200).json({ data });
});
