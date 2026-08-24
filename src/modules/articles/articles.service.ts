import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool } from "../../db/pool.js";
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { translateProductFields } from "../../shared/translate/translateProductFields.js";
import { translateLexicalContent } from "../../shared/utils/ImageSrc/translateLexicalContent.js";
import type { ArticleDTO, ArticleInput, ArticleSlugResponse, ArticleUpdateInput } from "./articles.type.js";

const languages = ["th", "en", "ja"] as const;

export async function list(st_id: number, lg_code: string): Promise<ArticleDTO[]> {
    const [rows] = await pool.query<(RowDataPacket & ArticleDTO)[]>(
        `SELECT *
         FROM Articles
         WHERE st_id = ? AND lg_code = ?
         ORDER BY art_published_at DESC, art_id DESC`,
        [st_id, lg_code]
    );

    return rows;
}

export async function publicList(lg_code: string, st_id?: number, homeOnly = false): Promise<ArticleDTO[]> {
    const params: Array<string | number> = [lg_code];
    let where = "WHERE lg_code = ?";

    if (st_id) {
        where += " AND st_id = ?";
        params.push(st_id);
    }

    if (homeOnly) {
        where += " AND art_show_home = 1";
    }

    const [rows] = await pool.query<(RowDataPacket & ArticleDTO)[]>(
        `SELECT *
         FROM Articles
         ${where}
         ORDER BY art_published_at DESC, art_id DESC`,
        params
    );

    return rows;
}

export async function getBySlug(slug: string, lg_code: string): Promise<ArticleDTO | null> {
    const [rows] = await pool.query<(RowDataPacket & ArticleDTO)[]>(
        `SELECT *
         FROM Articles
         WHERE art_slug = ? AND lg_code = ?
         LIMIT 1`,
        [slug, lg_code]
    );

    if (rows[0]) return rows[0];

    const [fallbackRows] = await pool.query<(RowDataPacket & ArticleDTO)[]>(
        `SELECT target.*
         FROM Articles source
         INNER JOIN Articles target
             ON target.group_id = source.group_id
            AND target.lg_code = ?
         WHERE source.art_slug = ?
         LIMIT 1`,
        [lg_code, slug]
    );

    return fallbackRows[0] ?? null;
}

export async function getById(art_id: number): Promise<ArticleDTO | null> {
    const [rows] = await pool.query<(RowDataPacket & ArticleDTO)[]>(
        `SELECT * FROM Articles WHERE art_id = ? LIMIT 1`,
        [art_id]
    );

    return rows[0] ?? null;
}

export async function getByGroupId(group_id: number): Promise<ArticleDTO | null> {
    const [rows] = await pool.query<(RowDataPacket & ArticleDTO)[]>(
        `SELECT * FROM Articles WHERE group_id = ? LIMIT 1`,
        [group_id]
    );

    return rows[0] ?? null;
}

async function getMaxGroupId(conn: PoolConnection): Promise<number> {
    const [rows] = await conn.query<(RowDataPacket & { nextGroupId: number })[]>(
        `SELECT COALESCE(MAX(group_id), 0) + 1 AS nextGroupId FROM Articles FOR UPDATE`
    );

    return rows[0]?.nextGroupId ?? 1;
}

function removeLang(slug: string): string {
    return slug.replace(/-(th|en|ja)$/, "");
}

export async function generateUniqueSlug(slug: string): Promise<string> {
    const conn = await pool.getConnection();

    try {
        const [rows] = await conn.query<(RowDataPacket & ArticleSlugResponse)[]>(
            `SELECT art_slug FROM Articles WHERE art_slug LIKE ?`,
            [`${slug}-%`]
        );

        const slugs = rows.map((row) => removeLang(row.art_slug));
        const numbers = slugs.map((item) => {
            const match = item.match(/-(\d+)$/);
            return match ? Number(match[1]) : 0;
        });

        const max = numbers.length > 0 ? Math.max(...numbers) : 0;
        return `${slug}-${max + 1}`;
    } finally {
        conn.release();
    }
}

export async function create(input: ArticleInput): Promise<number> {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const groupId = await getMaxGroupId(conn);
        const fields = await translateProductFields([
            input.art_title,
            input.art_summary,
            input.art_seo_title,
            input.art_seo_description,
        ]);
        const content = await translateLexicalContent(input.art_content);

        let firstInsertId = 0;

        for (const lang of languages) {
            const payload = {
                art_title: fields[lang][0] ?? "",
                art_summary: fields[lang][1] ?? "",
                art_content: content[lang] ?? "",
                art_image_url: input.art_image_url,
                art_slug: `${input.art_slug}-${lang}`,
                art_seo_title: fields[lang][2] ?? "",
                art_seo_description: fields[lang][3] ?? "",
                art_published_at: input.art_published_at,
                art_show_home: input.art_show_home ? 1 : 0,
                lg_code: lang,
                group_id: groupId,
                st_id: input.st_id,
                e_id: input.e_id,
            };

            const [res] = await conn.query<ResultSetHeader>(`INSERT INTO Articles SET ?`, payload);
            if (!firstInsertId) firstInsertId = res.insertId;
        }

        await conn.commit();
        return firstInsertId;
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    } finally {
        conn.release();
    }
}

export async function update(input: ArticleUpdateInput): Promise<number> {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();
        input.update_at = new Date().toISOString();

        const [res] = await conn.query<ResultSetHeader>(
            `UPDATE Articles SET ? WHERE art_id = ?`,
            [input, input.art_id]
        );

        if (res.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        await conn.commit();
        return res.affectedRows;
    } catch (err) {
        await conn.rollback();
        if (isDupError(err)) throw new ApiError(409, CommonMessages.isExits);
        throw err;
    } finally {
        conn.release();
    }
}

export async function remove(group_id: number): Promise<void> {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const [res] = await conn.query<ResultSetHeader>(
            `DELETE FROM Articles WHERE group_id = ?`,
            [group_id]
        );

        if (res.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }

        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (isFkConstraintError(err)) throw new ApiError(409, CommonMessages.used);
        throw err;
    } finally {
        conn.release();
    }
}
