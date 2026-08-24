export type StatusLangDTO = {
    s_id: number;
    s_code: string;
    lg_code: string;
    s_name: string;
    created_at?: string | null;
    updated_at?: string | null;
};

export type UpdateStatusLangInput = {
    s_name: string;
};
