export type ArticleDTO = {
    art_id: number;
    art_title: string;
    art_summary: string;
    art_content: string;
    art_image_url: string | null;
    art_slug: string;
    art_seo_title: string;
    art_seo_description: string;
    art_published_at: string;
    art_show_home: number | boolean;
    lg_code: string;
    group_id: number;
    st_id: number;
    e_id: number;
    create_at: string;
    update_at: string | null;
}

export type ArticleInput = {
    art_title: string;
    art_summary: string;
    art_content: string;
    art_image_url: string | null;
    art_slug: string;
    art_seo_title: string;
    art_seo_description: string;
    art_published_at: string;
    art_show_home?: number | boolean;
    st_id: number;
    e_id: number;
}

export type ArticleUpdateInput = {
    art_id: number;
    art_title: string;
    art_summary: string;
    art_content: string;
    art_image_url: string | null;
    art_slug: string;
    art_seo_title: string;
    art_seo_description: string;
    art_published_at: string;
    art_show_home?: number | boolean;
    e_id: number;
    update_at?: string;
}

export type ArticleSlugResponse = {
    art_slug: string;
}
