

export type CategoryDTO = {
    c_id: number;
    c_sort_order: number;
    e_id: number;
    ctl_id: number;
    cl_name: string;
    lg_code: string;
    ctl_name: string;
    cl_id: number;
    ctl_description: string;
    e_usercode: string;
};

export type CreateCategoryInput = {
    e_id: number;
    ctl_id: number;
    cl_name: string;
}

export type UpdateCategoryInput = {
    cl_name: string;
    c_id: number;
    ctl_id: number;
}