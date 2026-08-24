import fs from "fs"
import path from "path"
import { pool } from "../../db/pool.js"
import { ApiError } from "../../shared/errors/ApiError.js"
import type {
    UpsertHeroBackgroundInput,
    UpsertHeroSlideInput,
    UpsertThemeInput,
    WebsiteHeroBackground,
    WebsiteHeroSlide,
    WebsiteKey,
    WebsiteTheme,
} from "./website-theme.type.js"

let heroTablesReady: Promise<void> | null = null
let themeColumnsReady: Promise<void> | null = null

type CleanupResult = {
    deleted: string[]
    failed: { path: string; message: string }[]
}

function parseJsonArray(value: unknown): string[] {
    if (!value) return []
    if (Array.isArray(value)) return value as string[]
    if (typeof value === "string") return JSON.parse(value) as string[]
    return []
}

function normalizeSlide(row: any): WebsiteHeroSlide {
    return {
        ...row,
        is_active: Boolean(row.is_active),
    }
}

function normalizeUploadPath(value: string | null | undefined): string | null {
    if (!value || /^(data:|blob:|https?:\/\/)/i.test(value)) return null

    const cleaned = value.replace(/\\/g, "/").replace(/^\/+/, "")
    const normalized = path.posix.normalize(cleaned)
    if (!normalized.startsWith("uploads/theme/") && !normalized.startsWith("uploads/hero/")) {
        return null
    }

    return normalized
}

function uniqueUploadPaths(paths: Array<string | null | undefined>): string[] {
    return [...new Set(paths.map(normalizeUploadPath).filter((value): value is string => Boolean(value)))]
}

function getUploadRoot() {
    return path.resolve(process.cwd(), "public", "uploads")
}

function getPublicFilePath(uploadPath: string): string | null {
    const fullPath = path.resolve(process.cwd(), "public", uploadPath)
    const uploadRoot = getUploadRoot()

    if (fullPath !== uploadRoot && fullPath.startsWith(`${uploadRoot}${path.sep}`)) {
        return fullPath
    }

    return null
}

async function collectReferencedWebsiteImagePaths(): Promise<Set<string>> {
    await ensureThemeColumns()
    await ensureHeroTables()

    const refs = new Set<string>()
    const queries = [
        "SELECT bg_image_url AS image_url FROM website_theme WHERE bg_image_url IS NOT NULL",
        "SELECT hero_bg_image_url AS image_url FROM website_hero_settings WHERE hero_bg_image_url IS NOT NULL",
        "SELECT image_url FROM website_hero_slides WHERE image_url IS NOT NULL",
    ]

    for (const query of queries) {
        const [rows] = await pool.query<any[]>(query)
        for (const row of rows) {
            const uploadPath = normalizeUploadPath(row.image_url)
            if (uploadPath) refs.add(uploadPath)
        }
    }

    return refs
}

async function deleteUnreferencedPaths(paths: string[]): Promise<CleanupResult> {
    const referenced = await collectReferencedWebsiteImagePaths()
    const result: CleanupResult = { deleted: [], failed: [] }

    for (const uploadPath of uniqueUploadPaths(paths)) {
        if (referenced.has(uploadPath)) continue

        const fullPath = getPublicFilePath(uploadPath)
        if (!fullPath) continue

        try {
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath)
                result.deleted.push(uploadPath)
            }
        } catch (error) {
            result.failed.push({
                path: uploadPath,
                message: error instanceof Error ? error.message : String(error),
            })
        }
    }

    return result
}

function listFilesRecursive(dir: string): string[] {
    if (!fs.existsSync(dir)) return []

    const files: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            files.push(...listFilesRecursive(fullPath))
        } else if (entry.isFile()) {
            files.push(fullPath)
        }
    }

    return files
}

async function ensureThemeColumns(): Promise<void> {
    if (!themeColumnsReady) {
        themeColumnsReady = (async () => {
            const columns = [
                ["header_bg_color", "VARCHAR(32) NULL"],
                ["header_font_color", "VARCHAR(32) NULL"],
                ["footer_bg_color", "VARCHAR(32) NULL"],
                ["footer_font_color", "VARCHAR(32) NULL"],
            ] as const

            for (const [name, definition] of columns) {
                const [rows] = await pool.query<any[]>(
                    `SELECT COLUMN_NAME
                     FROM INFORMATION_SCHEMA.COLUMNS
                     WHERE TABLE_SCHEMA = DATABASE()
                       AND TABLE_NAME = 'website_theme'
                       AND COLUMN_NAME = ?`,
                    [name]
                )

                if (rows.length === 0) {
                    await pool.query(`ALTER TABLE website_theme ADD COLUMN ${name} ${definition}`)
                }
            }
        })()
    }

    await themeColumnsReady
}

async function ensureHeroTables(): Promise<void> {
    if (!heroTablesReady) {
        heroTablesReady = (async () => {
            // สร้างตาราง hero แยกจาก website_theme เพื่อไม่ให้พื้นหลังเว็บเดิมปนกับข้อมูลสไลด์
            await pool.query(`
                CREATE TABLE IF NOT EXISTS website_hero_settings (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    website_key VARCHAR(32) NOT NULL UNIQUE,
                    hero_bg_type ENUM('color', 'image') NOT NULL DEFAULT 'color',
                    hero_bg_colors JSON NULL,
                    hero_bg_image_url VARCHAR(500) NULL,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
            `)

            await pool.query(`
                CREATE TABLE IF NOT EXISTS website_hero_slides (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    website_key VARCHAR(32) NOT NULL,
                    image_url VARCHAR(500) NOT NULL,
                    title VARCHAR(255) NULL,
                    description TEXT NULL,
                    link_url VARCHAR(500) NULL,
                    sort_order INT NOT NULL DEFAULT 0,
                    is_active TINYINT(1) NOT NULL DEFAULT 1,
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_website_hero_slides_key_order (website_key, sort_order)
                )
            `)
        })()
    }

    await heroTablesReady
}

export async function getTheme(websiteKey: WebsiteKey): Promise<WebsiteTheme | null> {
    await ensureThemeColumns()
    await ensureHeroTables()

    const [rows] = await pool.query<any[]>(
        "SELECT * FROM website_theme WHERE website_key = ?",
        [websiteKey]
    )
    const row = rows[0]
    const heroBackground = await getHeroBackground(websiteKey)
    const heroSlides = await getHeroSlides(websiteKey, true)
    if (!row) {
        return {
            id: 0,
            website_key: websiteKey,
            bg_type: "color",
            bg_colors: [],
            bg_image_url: null,
            header_bg_color: null,
            header_font_color: null,
            footer_bg_color: null,
            footer_font_color: null,
            updated_at: "",
            hero_background: heroBackground,
            hero_slides: heroSlides,
        }
    }

    return {
        ...row,
        bg_colors: parseJsonArray(row.bg_colors),
        hero_background: heroBackground,
        hero_slides: heroSlides,
    }
}

export async function upsertTheme(websiteKey: WebsiteKey, input: UpsertThemeInput): Promise<void> {
    await ensureThemeColumns()

    if (input.bg_type === "color" && (!input.bg_colors || input.bg_colors.length === 0)) {
        throw new ApiError(400, "ต้องระบุค่าสีอย่างน้อย 1 สี")
    }
    if (input.bg_type === "image" && !input.bg_image_url) {
        throw new ApiError(400, "ต้องระบุ URL รูปภาพ")
    }

    const current = await getTheme(websiteKey)

    await pool.query(
        `INSERT INTO website_theme (
             website_key,
             bg_type,
             bg_colors,
             bg_image_url,
             header_bg_color,
             header_font_color,
             footer_bg_color,
             footer_font_color
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
             bg_type           = VALUES(bg_type),
             bg_colors         = VALUES(bg_colors),
             bg_image_url      = VALUES(bg_image_url),
             header_bg_color   = VALUES(header_bg_color),
             header_font_color = VALUES(header_font_color),
             footer_bg_color   = VALUES(footer_bg_color),
             footer_font_color = VALUES(footer_font_color)`,
        [
            websiteKey,
            input.bg_type,
            input.bg_colors ? JSON.stringify(input.bg_colors) : null,
            input.bg_image_url ?? null,
            input.header_bg_color?.trim() || null,
            input.header_font_color?.trim() || null,
            input.footer_bg_color?.trim() || null,
            input.footer_font_color?.trim() || null,
        ]
    )

    if (current?.bg_image_url && current.bg_image_url !== input.bg_image_url) {
        await deleteUnreferencedPaths([current.bg_image_url])
    }
}

export async function getHeroBackground(websiteKey: WebsiteKey): Promise<WebsiteHeroBackground | null> {
    await ensureHeroTables()

    const [rows] = await pool.query<any[]>(
        "SELECT * FROM website_hero_settings WHERE website_key = ?",
        [websiteKey]
    )
    const row = rows[0]
    if (!row) return null

    return {
        ...row,
        hero_bg_colors: parseJsonArray(row.hero_bg_colors),
    }
}

export async function upsertHeroBackground(
    websiteKey: WebsiteKey,
    input: UpsertHeroBackgroundInput
): Promise<void> {
    await ensureHeroTables()

    if (input.hero_bg_type === "color" && (!input.hero_bg_colors || input.hero_bg_colors.length === 0)) {
        throw new ApiError(400, "ต้องระบุค่าสีพื้นหลัง Header Hero อย่างน้อย 1 สี")
    }
    if (input.hero_bg_type === "image" && !input.hero_bg_image_url) {
        throw new ApiError(400, "ต้องระบุ URL รูปภาพพื้นหลัง Header Hero")
    }

    const current = await getHeroBackground(websiteKey)

    await pool.query(
        `INSERT INTO website_hero_settings (website_key, hero_bg_type, hero_bg_colors, hero_bg_image_url)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
             hero_bg_type      = VALUES(hero_bg_type),
             hero_bg_colors    = VALUES(hero_bg_colors),
             hero_bg_image_url = VALUES(hero_bg_image_url)`,
        [
            websiteKey,
            input.hero_bg_type,
            input.hero_bg_colors ? JSON.stringify(input.hero_bg_colors) : null,
            input.hero_bg_image_url ?? null,
        ]
    )

    if (current?.hero_bg_image_url && current.hero_bg_image_url !== input.hero_bg_image_url) {
        await deleteUnreferencedPaths([current.hero_bg_image_url])
    }
}

export async function getHeroSlides(
    websiteKey: WebsiteKey,
    activeOnly = false
): Promise<WebsiteHeroSlide[]> {
    await ensureHeroTables()

    const [rows] = await pool.query<any[]>(
        `SELECT *
         FROM website_hero_slides
         WHERE website_key = ? ${activeOnly ? "AND is_active = 1" : ""}
         ORDER BY sort_order ASC, id ASC`,
        [websiteKey]
    )

    return rows.map(normalizeSlide)
}

export async function upsertHeroSlides(
    websiteKey: WebsiteKey,
    slides: UpsertHeroSlideInput[]
): Promise<void> {
    await ensureHeroTables()

    if (slides.length > 5) {
        throw new ApiError(400, "Header Hero slide เพิ่มได้สูงสุด 5 รูป")
    }
    if (slides.some((slide) => !slide.image_url)) {
        throw new ApiError(400, "ทุก slide ต้องมีรูปภาพ")
    }

    const currentSlides = await getHeroSlides(websiteKey)
    const conn = await pool.getConnection()
    try {
        await conn.beginTransaction()

        // บันทึกแบบ replace ทั้งชุด เพราะ backoffice เป็นตัวกำหนดลำดับล่าสุดของรายการทั้งหมด
        await conn.query("DELETE FROM website_hero_slides WHERE website_key = ?", [websiteKey])

        for (const [index, slide] of slides.entries()) {
            await conn.query(
                `INSERT INTO website_hero_slides
                    (website_key, image_url, title, description, link_url, sort_order, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    websiteKey,
                    slide.image_url,
                    slide.title?.trim() || null,
                    slide.description?.trim() || null,
                    slide.link_url?.trim() || null,
                    index,
                    slide.is_active === false ? 0 : 1,
                ]
            )
        }

        await conn.commit()

        const nextImageUrls = new Set(uniqueUploadPaths(slides.map((slide) => slide.image_url)))
        const removedImageUrls = currentSlides
            .map((slide) => slide.image_url)
            .filter((imageUrl) => {
                const uploadPath = normalizeUploadPath(imageUrl)
                return uploadPath && !nextImageUrls.has(uploadPath)
            })

        await deleteUnreferencedPaths(removedImageUrls)
    } catch (error) {
        await conn.rollback()
        throw error
    } finally {
        conn.release()
    }
}

export async function cleanupUnusedWebsiteImages(): Promise<CleanupResult> {
    const uploadRoot = getUploadRoot()
    const folders = ["theme", "hero"]
    const allFiles = folders.flatMap((folder) => listFilesRecursive(path.join(uploadRoot, folder)))
    const uploadPaths = allFiles.map((filePath) => {
        const relative = path.relative(path.join(process.cwd(), "public"), filePath)
        return relative.replace(/\\/g, "/")
    })

    return deleteUnreferencedPaths(uploadPaths)
}
