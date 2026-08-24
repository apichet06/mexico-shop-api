export type UpdateCartItemInput = {
    ci_id: number;
    u_id: number;
    is_selected: 0 | 1;
};

export type UpdateCartItemQtyInput = {
    ci_id: number;
    u_id: number;
    qty: number;
};

export type AddCartItemInput = {
    u_id: number;
    pv_id: number;
    qty: number;
};

export type CartItemDTO = {
    ci_id: number;
    cart_id: number;
    pv_id: number;
    qty: number;
    unit_price: number;
    discount_amount: number;
    line_total: number;
    created_at: string;
    updated_at: string;
};

export type CartItemDetailDTO = {
    ci_id: number;
    cart_id: number;
    pv_id: number;
    qty: number;
    unit_price: number;
    discount_amount: number;
    line_total: number;
    is_selected: 0 | 1;
    pv_sku: string | null;
    variant_label: string | null;
    image_url: string | null;
    p_id: number;
    ctl_id: number;
    p_name: string | null;
    st_id: number;
    st_company_name: string | null;
};

export type CartDTO = {
    cart_id: number;
    status: string;
    items: CartItemDetailDTO[];
    total_amount: number;
    item_count: number;
};
