
export type empDTO = {
    e_id: number;
    e_firstname: string;
    e_lastname: string;
    e_password: string;
    e_address: string;
    e_email: string;
    e_phone: string;
    e_image: string;
    e_isActive: boolean;
    e_add_datetime: string
    e_add_name: string;
    e_upd_name: string;
    e_status: string;
    st_company_name: string;
    st_id: number,
    st_image: string;
    is_platform_store: boolean | 0 | 1 | "0" | "1";
    e_email_verified_at?: string | Date | null;
}

export type CreateEmpInput = {
    e_firstname: string;
    e_lastname: string;
    e_password: string;
    e_email: string;
    e_phone: string;
    e_isActive: string;
    e_status: string;
    st_id: number;
}

export type CreateStoreInput = {
    st_company_name: string;
    _company_name: string;
    st_idcard: string;
    bank_name: string;
    account_number: string;
    omise_recipient_id: string;
    st_email: string;
    created_at: string;
    st_phone: string;
    st_image: string | null;
    e_id: number;
}

export type CreateLocationInput = {
    loc_name: string;
    loc_address: string;
    loc_postcode: string;
    Subdistricts_id: number;
    Districts_id: number;
    Provinces_id: number;
}



export type UpdateEmpInput = {
    e_firstname: string;
    e_lastname: string;
    e_email: string;
    e_phone: string;
    e_image: string;
    e_isActive: string;
    e_upd_name: string;
    e_status: string;
    st_id: number;
}
