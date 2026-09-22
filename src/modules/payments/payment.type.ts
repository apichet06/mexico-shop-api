export type PaymentMethod = "conekta";

export type ConektaCheckoutInput = {
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

export type ConektaOrderResponse = {
    id: string;
    amount: number;
    currency: string;
    payment_status: string | null;
    livemode: boolean;
    metadata?: { payment_no?: string };
    checkout?: { url?: string | null };
    charges?: { data?: { payment_method?: { expires_at?: number | null } }[] };
};
