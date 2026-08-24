export type OmisePaymentMethod =
    | "card"
    | "promptpay"
    | "mobile_banking_kbank"
    | "mobile_banking_scb";

export type OmiseChargeInput = {
    u_id: number;
    order_ids: number[];
    payment_method: OmisePaymentMethod;
    omise_token?: string;
    omise_source?: string;
    saved_payment_method_id?: number;
    save_card?: boolean;
};

export type PaymentResultDTO = {
    pay_id: number;
    payment_no: string;
    payment_status: "paid" | "pending" | "failed";
    payment_ref: string | null;
    amount_total: number;
    authorize_uri?: string | null;
    qr_code_uri?: string | null;
    order_ids: number[];
};

export type OmiseChargeResponse = {
    id?: string;
    object?: string;
    amount?: number;
    currency?: string;
    status?: string;
    paid?: boolean;
    failure_code?: string | null;
    failure_message?: string | null;
    authorize_uri?: string | null;
    source?: {
        id?: string;
        type?: string;
        scannable_code?: {
            image?: {
                download_uri?: string | null;
            } | null;
        } | null;
    } | null;
};

export type OmiseRefundResponse = {
    id?: string;
    object?: string;
    amount?: number;
    currency?: string;
    status?: string;
    charge?: string;
    transaction?: string | null;
    failure_code?: string | null;
    failure_message?: string | null;
};

export type SavedPaymentMethodDTO = {
    upm_id: number;
    provider: "omise";
    provider_customer_id: string;
    provider_card_id: string;
    card_brand: string | null;
    card_last4: string;
    card_name: string | null;
    expiration_month: number | null;
    expiration_year: number | null;
    is_default: boolean;
    created_at: string;
    updated_at: string;
};

export type OmiseCardDTO = {
    id?: string;
    object?: string;
    deleted?: boolean;
    fingerprint?: string | null;
    brand?: string | null;
    last_digits?: string | null;
    name?: string | null;
    expiration_month?: number | null;
    expiration_year?: number | null;
};

export type OmiseTokenDTO = {
    id?: string;
    object?: "token";
    used?: boolean;
    card?: OmiseCardDTO | null;
};

export type OmiseCustomerDTO = {
    id?: string;
    object?: string;
    email?: string | null;
    default_card?: string | null;
    cards?: {
        data?: OmiseCardDTO[];
    } | null;
};
