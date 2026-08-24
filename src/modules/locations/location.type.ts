export type LocationsDTO = {
    loc_id: number;
    loc_name: string;
    loc_address: string;
    loc_postcode: string;
    st_id: number;
    Subdistricts_id: number;
    Districts_id: number;
    Provinces_id: number;
    created_at: string;
};

export type CreateLocationInput = {
    loc_address: string;
    zip_code: string;
    st_id: number;
    Subdistricts_id: number;
    Districts_id: number;
    Provinces_id: number;
    is_default: boolean;
};

export type UpdateLocationInput = {
    loc_id: number;
    loc_address: string;
    loc_postcode: string;
    st_id: number;
    Subdistricts_id: number;
    Districts_id: number;
    Provinces_id: number;
    is_default: boolean;

};

