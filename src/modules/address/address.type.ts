export type ProvinceDTO = {
    id: number;
    code: string;
    name_in_thai: string;
    name_in_english: string;
};

export type DistrictsDTO = {
    id: number;
    code: string;
    name_in_thai: string;
    name_in_english: string;
    Provinces_id: number;
};

export type SubDistrictsDTO = {
    id: number;
    code: string;
    name_in_thai: string;
    name_in_english: string;
    latitude: string;
    longitude: string;
    Districts_id: number;
    zip_code: string;
};