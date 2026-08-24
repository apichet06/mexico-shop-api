export type SellerApplicationProvider = "GOOGLE" | "FACEBOOK";

export type SellerApplicationAccountDTO = {
    id: number;
    provider: SellerApplicationProvider;
    provider_user_id: string;
    email: string | null;
    email_verified: 0 | 1;
    display_name: string | null;
    avatar_url: string | null;
    created_at: string;
    last_login_at: string | null;
};

export type SellerApplicationDTO = {
    id: number;
    account_id: number;
    current_step: number;
    completed_steps_json: number[] | null;
    payload_json: Record<string, unknown> | null;
    is_finalized: 0 | 1;
    finalized_at: string | null;
    created_store_id: number | null;
    created_at: string;
    updated_at: string | null;
};

export type SellerApplicationSession = {
    account: SellerApplicationAccountDTO;
    application: SellerApplicationDTO;
};

export type SellerApplicationTokenPayload = {
    sellerApplicationId: number;
    sellerApplicationAccountId: number;
};

export type OAuthProfile = {
    provider: SellerApplicationProvider;
    provider_user_id: string;
    email: string | null;
    email_verified: boolean;
    display_name: string | null;
    avatar_url: string | null;
};
