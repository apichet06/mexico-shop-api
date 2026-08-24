export type AddStockProduct = {
    pv_id: number;
    loc_id: number;
    addOn_hand: number;
    e_id: number;
    st_id: number;
}

export type ReduceStoskProduct = {
    pv_id: number;
    loc_id: number;
    reduceOn_hand: number;
    e_id: number;
    st_id: number;
}

export type StockProductResponse = {
    pv_id: number,
    pv_sku: string
    pv_cost: number
    pv_price: number
    stock: number
    is_default: boolean
    image_url: string
    p_id: number
    weight_g: number
    length_cm: number
    width_cm: number
    height_cm: number
    discount: number
    e_id: number
    unit_id: number
    poi_values: string
    ul_name: string
    lg_code: string
    on_hand: number
    reserved_qty: number
}

export type InventoryLogResponse = {
    invl_id: number,
    create_at: string
    on_hand: number
    ivnl_status: string
    inv_id: number
    pv_id: number
    st_id: number
    e_id: number
    poi_values: string
    e_firstname: string
    pv_sku?: string
    p_name?: string
    loc_name?: string
    province?: string
}

export type InactiveStockResponse = {
    inv_id: number
    st_id: number
    pv_id: number
    loc_id: number
    p_id: number
    p_name: string
    pv_sku: string
    image_url: string | null
    poi_values: string | null
    on_hand: number
    reserved_qty: number
    loc_name: string
    province: string
    last_sold_at: string | null
    sold_qty: number
    inactive_days: number | null
}
