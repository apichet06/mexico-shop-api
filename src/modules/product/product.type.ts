import type { ProductTagsDTO } from "../productTags/productTags.type.js";

export type ProductLanges = {
  pl_id: number;
  p_title: string;
  p_name: string;
  p_description: string;
  p_id: number;
  lg_code: string;
};

export type ProductDTO = {
  p_id: number;
  p_code: string;
  p_isActive: boolean;
  p_create_at: string;
  p_update_at: string;
  c_id: number;
  e_id: number;
  b_id: number;
  produtTag: ProductTagsDTO[];
  ctl_id: number;
  ps_id: number;
};

export type CreateProductInput = {
  c_id: number;
  e_id: number;
  b_id: number;
  ptag_id: number[];
  ps_id: number;
  images: string[];
  p_name: string;
  p_description: string;
  p_isActive: boolean;
  p_preorder_delivery_days: number | null;
  st_id: number;
};

export type UpdateProductInput = {
  c_id: number;
  e_id: number;
  b_id: number;
  ptag_id: number[];
  ps_id: number;
  p_name: string;
  p_description: string;
  p_isActive: boolean;
  p_preorder_delivery_days: number | null;
  existing_image_ids?: number[];
};

export type ImageProductRow = {
  ip_id: number;
  ip_image_url: string;
  is_primary: number | null;
  p_id: number;
};

export type SubmitPayload = {
  p_id: number | null;
  e_id: number;
  st_id: number;
  optionItems: {
    poi_id?: number;
    otype_id: number;
    poi_code: string;
    poi_value: string;
  }[];
  variants: {
    pv_sku: string;
    pv_cost: number;
    pv_price: number;
    discount: number;
    weight_g: number;
    length_cm: number;
    width_cm: number;
    height_cm: number;
    is_default: boolean;
    image_url: string;
    unit_id?: number;
    pv_id?: number;
  }[];
  variantOptionItems: {
    pv_id: number;
    poi_id: number;
  }[];
  inventory: {
    pv_id: number;
    loc_id: number;
    on_hand: number;
    reserved_qty: number;
  }[];
};

export type OptionVariantDetailResponse = {
  p_id: number;
  e_id: number;
  optionItems: {
    poi_id: number;
    potn_id: number;
    otype_id: number;
    poi_code: string;
    poi_value: string;
  }[];
  variants: {
    pv_id: number;
    pv_sku: string;
    pv_cost: number;
    pv_price: number;
    discount: number;
    weight_g: number;
    length_cm: number;
    width_cm: number;
    height_cm: number;
    is_default: boolean;
    image_url: string;
    unit_id?: number;
  }[];
  variantOptionItems: {
    pv_id: number;
    poi_id: number;
  }[];
  inventory: {
    inv_id: number;
    pv_id: number;
    loc_id: number;
    on_hand: number;
    reserved_qty: number;
  }[];
};

export type VariantImageRow = {
  pv_id: number;
  image_url: string | null;
};
