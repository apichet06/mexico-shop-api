export type ProductTagsDTO = {
    ptag_id: number;
    ptag_name: string;
    lg_code: string;
    e_id: number;
    e_status: string;
    e_usercode: string;
    e_create_at: string;
}

export type CreateProductTagsInput = {
    e_id: number;
    ptag_name: string;
}

export type UpdateProductTagsInput = {
    ptag_name: string;
    ptt_id: number;
}