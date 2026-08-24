export type BrandsDTO = {
    b_name: string;
    e_id: number;
    b_id: number;
    ctl_id: number;
    ctl_name: string;
    ctl_description: string;
    e_create_at: string;
}

export type CreateBrandsInput = {
    b_name: string;
    e_id: number;
    ctl_id: number;
}

export type UpdateBrandsInput = {
    b_name: string;
    b_id: number;
    ctl_id: number;
}
