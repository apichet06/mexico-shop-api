export type UnitLangsDTO = {
    ul_id: number;
    ul_name: string;
    u_id: number;
    lg_code: string;
    e_id: number;

}

export type CreateUnitInput = {
    e_id: number;
    ul_name: string;
}

export type UpdateUnitInput = {
    ul_name: string;
    ul_id: number;
}