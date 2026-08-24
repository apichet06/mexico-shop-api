export type WebsiteKey = "arcana" | "deadstock"
export type BgType = "color" | "image"
export type HeroBgType = "color" | "image"

export interface WebsiteTheme {
    id: number
    website_key: WebsiteKey
    bg_type: BgType
    bg_colors: string[]
    bg_image_url: string | null
    header_bg_color: string | null
    header_font_color: string | null
    footer_bg_color: string | null
    footer_font_color: string | null
    updated_at: string
    hero_background?: WebsiteHeroBackground | null
    hero_slides?: WebsiteHeroSlide[]
}

export interface UpsertThemeInput {
    bg_type: BgType
    bg_colors?: string[]
    bg_image_url?: string | null
    header_bg_color?: string | null
    header_font_color?: string | null
    footer_bg_color?: string | null
    footer_font_color?: string | null
}

export interface WebsiteHeroBackground {
    id: number
    website_key: WebsiteKey
    hero_bg_type: HeroBgType
    hero_bg_colors: string[]
    hero_bg_image_url: string | null
    updated_at: string
}

export interface WebsiteHeroSlide {
    id: number
    website_key: WebsiteKey
    image_url: string
    title: string | null
    description: string | null
    link_url: string | null
    sort_order: number
    is_active: boolean
    created_at: string
    updated_at: string
}

export interface UpsertHeroBackgroundInput {
    hero_bg_type: HeroBgType
    hero_bg_colors?: string[]
    hero_bg_image_url?: string | null
}

export interface UpsertHeroSlideInput {
    image_url: string
    title?: string | null
    description?: string | null
    link_url?: string | null
    is_active?: boolean
}
