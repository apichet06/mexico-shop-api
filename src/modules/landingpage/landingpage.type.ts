export type LandingpageDTO = {
    lp_id: number
    lp_title: string
    lp_description: string
    lp_imag_url: string
    lp_seo_title: string
    lp_seo_description: string
    lp_slug: string
    e_id: number
    p_id: number
    lg_code: string
    create_at: string
    update_at: string
}

export type LandingpageInput = {
    lp_title: string;
    lp_description: string;
    lp_imag_url: string;
    e_id: number;
    p_id: number;
    lg_code: string;
    lp_seo_title: string;
    lp_seo_description: string;
    lp_slug: string;
    group_id: number;
    st_id: number;

}

export type SlugDataresponse = {
    lp_slug: string;
}

export type LandingpageUpdateInput = {
    lp_id: number;
    lp_title: string;
    lp_description: string;
    lp_imag_url: string;
    e_id: number;
    update_at: string;
    lp_seo_title: string;
    lp_seo_description: string;
}