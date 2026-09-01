export type ShippingAddress = {
  name: string;
  address: string;
  district?: string | null;
  state?: string | null;
  province?: string | null;
  postcode: string;
  tel: string;
  email?: string | null;
};

export type ShippingParcel = {
  name: string;
  weight: number;
  width: number;
  length: number;
  height: number;
};

export type CreateShippingShipmentInput = {
  email: string;
  orderNo: string;
  courierCode: string;
  from: ShippingAddress;
  to: ShippingAddress;
  parcel: ShippingParcel;
  products: Array<{
    product_code: string;
    name: string;
    price: number;
    amount: number;
    weight: number;
  }>;
  declaredValue: number;
  codAmount?: number;
  remark?: string | null;
};

export type ShippingTrackingState = {
  status: string | null;
  datetime: string;
  location: string | null;
  description: string;
  info?: unknown;
  raw: unknown;
};

export type ShippingTrackingResult = {
  status: boolean;
  orderStatus: string | null;
  trackingCode: string;
  courierTrackingCode: string | null;
  states: ShippingTrackingState[];
  raw: unknown;
};

