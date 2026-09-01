export type PaymentMethod = "mercado_pago";

export type MercadoPagoCheckoutInput = {
    u_id: number;
    order_ids: number[];
    payment_method: PaymentMethod;
};

export type PaymentResultDTO = {
    pay_id: number;
    payment_no: string;
    payment_status: "paid" | "pending" | "failed";
    payment_ref: string | null;
    amount_total: number;
    checkout_url?: string | null;
    order_ids: number[];
};

export type MercadoPagoPreferenceResponse = {
    id?: string;
    init_point?: string;
    sandbox_init_point?: string;
};

export type MercadoPagoPaymentResponse = {
    id?: number | string;
    status?: string;
    status_detail?: string;
    external_reference?: string | null;
    transaction_amount?: number;
};

export type MercadoPagoPaymentSearchResponse = {
    results?: MercadoPagoPaymentResponse[];
};

export type MercadoPagoRefundResponse = {
    id?: number | string;
    payment_id?: number | string;
    amount?: number;
    status?: string;
};
