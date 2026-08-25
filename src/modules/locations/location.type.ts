export type LocationsDTO = {
    loc_id: number;
    loc_name: string;
    loc_address: string;
    loc_postcode: string;
    st_id: number;
    Subdistricts_id: number | null;
    Districts_id: number | null;
    Provinces_id: number | null;
    country_code: "MX" | null;
    colonia: string | null;
    municipality: string | null;
    city: string | null;
    state: string | null;
    latitude: number | null;
    longitude: number | null;
    formatted_address: string | null;
    created_at: string;
};

export type CreateLocationInput = {
    loc_address: string;
    zip_code: string;
    st_id: number;
    Subdistricts_id?: number | null;
    Districts_id?: number | null;
    Provinces_id?: number | null;
    country_code?: "MX" | null;
    colonia?: string | null;
    municipality?: string | null;
    city?: string | null;
    state?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    formatted_address?: string | null;
    is_default: boolean;
};

export type UpdateLocationInput = CreateLocationInput;

