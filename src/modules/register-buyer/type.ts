export type RegisterBuyerInput = {
    u_username: string;
    u_email: string;
    u_password: string;
    u_birthday?: string | null;
    u_gender?: string | null;
    u_provider: string;
    locb_recipient_name: string;
    locb_phone: string;
    locb_address: string;
    colonia: string;
    municipality: string;
    city: string;
    state: string;
    zip_code: string;
    country_code: "MX";
    latitude?: number | null;
    longitude?: number | null;
    formatted_address?: string | null;
    is_default: boolean;
};

export type RegisterBuyerDTO = {
    u_id: number;
    u_username: string;
    u_email: string;
    u_avatar: string | null;
    u_create_at: string;
};

export type GoogleUserInfo = {
    id: string;
    email: string;
    name: string;
    picture: string;
};

export type FacebookUserInfo = {
    id: string;
    name: string;
    email?: string;
    picture?: { data: { url: string } };
};

export type AuthResult = {
    user: RegisterBuyerDTO;
    isNew: boolean;
};

export type RefreshTokenSessionInput = {
    u_id: number;
    user_agent?: string | null;
    ip_address?: string | null;
};

export type ProfileDTO = {
    u_id: number;
    u_username: string;
    u_email: string;
    u_avatar: string | null;
    u_birthday: string | null;
    u_gender: string | null;
    u_provider: string;
    u_create_at: string;
};

export type AddressDTO = {
    locb_id: number;
    locb_recipient_name: string;
    locb_phone: string;
    locb_address: string;
    country_code: "MX" | null;
    state: string | null;
    city: string | null;
    municipality: string | null;
    colonia: string | null;
    zip_code: string;
    latitude: number | null;
    longitude: number | null;
    formatted_address: string | null;
    provinces_id: number | null;
    districts_id: number | null;
    subdistricts_id: number | null;
    province_name: string | null;
    district_name: string | null;
    subdistrict_name: string | null;
    is_default: boolean;
};

export type AddAddressInput = {
    locb_recipient_name: string;
    locb_phone: string;
    locb_address: string;
    country_code: "MX";
    state: string;
    city: string;
    municipality: string;
    colonia: string;
    zip_code: string;
    latitude: number | null;
    longitude: number | null;
    formatted_address: string | null;
    is_default: boolean;
};
