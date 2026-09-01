export type CalcType = "WEIGHT_ONLY" | "CHARGEABLE_WEIGHT";

export interface ShippingCarrier {
  sc_id: number;
  sc_code: string;
  sc_name: string;
  provider_code: string;
  calc_type: CalcType;
  vol_divisor: number | null;
  tracking_url_template: string | null;
  is_active: number;
}

export interface CreateCarrierInput {
  sc_code: string;
  sc_name: string;
  provider_code: string;
  calc_type: CalcType;
  vol_divisor?: number | null;
  tracking_url_template?: string | null;
  is_active?: number;
}

export type UpdateCarrierInput = Partial<CreateCarrierInput>;

export interface CalculateInput {
  postcode: string;
  weight_g: number;
  length_cm?: number;
  width_cm?: number;
  height_cm?: number;
  origin_postcode?: string;
  origin_address?: string | null;
  origin_province?: string | null;
  origin_district?: string | null;
  origin_subdistrict?: string | null;
  destination_address?: string | null;
  destination_province?: string | null;
  destination_district?: string | null;
  destination_subdistrict?: string | null;
  st_id?: number;
}

export interface CalculateResult {
  sc_id: number;
  sc_code: string;
  sc_name: string;
  provider_code: string;
  calc_type: CalcType;
  billed_weight_g: number;
  price: number | null;
  provider_price: number | null;
  is_active: number;
  source: "skydropx";
}
