export type CalcType = "WEIGHT_ONLY" | "CHARGEABLE_WEIGHT";

export interface ShippingCarrier {
  sc_id: number;
  sc_code: string;
  sc_name: string;
  shippop_courier_code: string | null;
  calc_type: CalcType;
  vol_divisor: number | null;
  tracking_url_template: string | null;
  is_active: number;
}

export interface ShippingRate {
  sr_id: number;
  zone_code: string;
  weight_from: number;
  weight_to: number;
  sr_price: number;
  sc_id: number;
}

export interface PostcodeZoneRule {
  pzr_id: number;
  zone_code: string;
  postcode_from: number;
  postcode_to: number;
  priority: number;
  is_active: number;
  sc_id: number;
}

export interface CreateCarrierInput {
  sc_code: string;
  sc_name: string;
  shippop_courier_code?: string | null;
  calc_type: CalcType;
  vol_divisor?: number | null;
  tracking_url_template?: string | null;
  is_active?: number;
}

export type UpdateCarrierInput = Partial<CreateCarrierInput>;

export interface CreateRateInput {
  sc_id: number;
  zone_code: string;
  weight_from: number;
  weight_to: number;
  sr_price: number;
}

export type UpdateRateInput = Partial<Omit<CreateRateInput, "sc_id">>;

export interface CreateZoneRuleInput {
  sc_id: number;
  zone_code: string;
  postcode_from: number;
  postcode_to: number;
  priority: number;
  is_active?: number;
}

export type UpdateZoneRuleInput = Partial<Omit<CreateZoneRuleInput, "sc_id">>;

export interface CalculateInput {
  postcode: string;
  weight_g: number;
  volume_cm3?: number;
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
  shippop_courier_code?: string | null;
  calc_type: CalcType;
  billed_weight_g: number;
  zone_code: string;
  price: number | null;
  provider_price?: number | null;
  is_active: number;
  source?: "shippop" | "manual";
}
