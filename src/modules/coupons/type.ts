export type CouponDiscountType = "percent" | "amount";
export type UserCouponStatus = "claimed" | "used" | "expired" | "cancelled";

export type CouponDTO = {
    co_id: number;
    co_code: string;
    website_key: "arcana" | "deadstock" | "combined";
    discount_type: CouponDiscountType;
    discount_value: number;
    max_discount_amount: number | null;
    co_datetime_start: string;
    co_datetime_end: string;
    create_at: string;
    update_at: string | null;
    min_order_amount: number;
    usage_limit_total: number | null;
    usage_limit_per_user: number;
    active: 0 | 1;
    used_count: number;
    st_id: number;
    product_ids: number[];
};

export type CouponProductDTO = {
    co_id: number;
    p_id: number;
    p_code: string | null;
    p_name: string | null;
};

export type UserCouponDTO = {
    uc_id: number;
    co_id: number;
    u_id: number;
    or_id: number | null;
    claimed_at: string;
    used_at: string | null;
    status: UserCouponStatus;
    co_code: string;
    discount_type: CouponDiscountType;
    discount_value: number;
    max_discount_amount: number | null;
    co_datetime_start: string;
    co_datetime_end: string;
    min_order_amount: number;
    active: 0 | 1;
    st_id: number;
};

export type AvailableCouponDTO = CouponDTO & {
    is_claimed: boolean;
    user_coupon_status: UserCouponStatus | null;
};

export type CouponRedemptionDTO = {
    cr_id: number;
    co_id: number;
    u_id: number;
    or_id: number;
    co_code_snapshot: string;
    subtotal_amount: number;
    discount_amount: number;
    used_at: string;
};

export type CreateCouponInput = {
    co_code: string;
    discount_type: CouponDiscountType;
    discount_value: number;
    max_discount_amount?: number | null;
    co_datetime_start: string;
    co_datetime_end: string;
    min_order_amount?: number;
    usage_limit_total?: number | null;
    usage_limit_per_user?: number;
    active?: boolean | number;
    st_id: number;
    product_ids?: number[];
};

export type UpdateCouponInput = Partial<Omit<CreateCouponInput, "st_id">> & {
    st_id: number;
};

export type ValidateCouponInput = {
    u_id: number;
    co_code: string;
    st_id?: number;
};

export type ValidateCouponResult = {
    coupon: CouponDTO;
    subtotal_amount: number;
    discount_amount: number;
    grand_total_amount: number;
};

export type RedeemCouponInput = {
    u_id: number;
    or_id: number;
    co_id: number;
    subtotal_amount: number;
    discount_amount: number;
    co_code_snapshot: string;
};
