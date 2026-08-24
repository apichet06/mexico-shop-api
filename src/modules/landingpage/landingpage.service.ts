import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../../db/pool.js";
import type { LandingpageDTO, LandingpageInput, LandingpageUpdateInput, SlugDataresponse } from "./landingpage.type.js"
import { ApiError, isDupError, isFkConstraintError } from "../../shared/errors/ApiError.js";
import { CommonMessages } from "../../shared/messages/common.messages.js";
import { translateLexicalContent } from "../../shared/utils/ImageSrc/translateLexicalContent.js";
import type { PoolConnection } from "mysql2/promise";
import { translateProductText } from "../../shared/translate/translate.js";


export async function List(st_id: number, lg_code: string): Promise<LandingpageDTO[]> {
    const [res] = await pool.query<LandingpageDTO[] & RowDataPacket[]>(`SELECT a.*,c.p_name,b.p_code From LandingPages a
                  INNER JOIN Products b
                  ON a.p_id = b.p_id
                  INNER JOIN ProductLangs c 
                  ON c.p_id = b.p_id
				  WHERE a.st_id = ? and a.lg_code = ? and c.lg_code = ?
                  ORDER BY a.lp_id DESC`, [st_id, lg_code, lg_code]);

    return res;
}

export async function GetLandingPageName(lp_slug: string): Promise<LandingpageDTO | null> {
    const [rows] = await pool.query<(RowDataPacket[]) & LandingpageDTO[]>(`SELECT * FROM LandingPages WHERE lp_title = ?`, [lp_slug]);
    return rows[0] || null;

}
export async function GetLandingPageById(lp_id: number): Promise<LandingpageDTO | null> {
    const [rows] = await pool.query<(RowDataPacket[]) & LandingpageDTO[]>(`SELECT * FROM LandingPages WHERE lp_id = ?`, [lp_id]);
    return rows[0] || null;
}

export async function GetLandingPageByGroupId(group_id: number): Promise<LandingpageDTO | null> {
    const [rows] = await pool.query<(RowDataPacket[]) & LandingpageDTO[]>(`SELECT * FROM LandingPages WHERE group_id = ?`, [group_id]);
    return rows[0] || null;
}



export async function GetMaxGroupId(conn: PoolConnection): Promise<number> {
    const [rows] = await conn.query<(RowDataPacket & { nextGroupId: number })[]>(
        `SELECT COALESCE(MAX(group_id), 0) + 1 AS nextGroupId FROM LandingPages FOR UPDATE`
    );
    return rows[0]?.nextGroupId ?? 1;
}

function splitSlug(slug: string) {
    const parts = slug.split("-");
    const baseSlug = parts.join("-");
    return { baseSlug };
}
function removeLang(slug: string): string {
    return slug.replace(/-(th|en|ja)$/, '');
}

export async function generateUniqueSlug(slug: string): Promise<string> {
    const conn = await pool.getConnection();

    try {
        const { baseSlug } = splitSlug(slug);

        // ดึง slug ที่คล้ายกันทั้งหมด
        const [rows] = await conn.query<any[]>(
            `SELECT lp_slug FROM LandingPages WHERE lp_slug LIKE ?`,
            [`${baseSlug}-%`]
        );
        const slugs = rows.map(r => removeLang(r.lp_slug));
        // console.log(slugs);

        const numbers = slugs.map(s => {
            const match = s.match(/-(\d+)$/);
            return match ? parseInt(match[1]!) : 0;
        });

        const max = numbers.length > 0 ? Math.max(...numbers) : 0;
        return `${baseSlug}-${max + 1}`;
    } finally {
        conn.release();
    }
}


export async function CreateLandingPage(input: LandingpageInput): Promise<number> {
    const conn = await pool.getConnection();

    try {
        await conn.beginTransaction();

        const groupId = await GetMaxGroupId(conn);

        const lp_title = await translateProductText(input.lp_title);
        const lp_seo_title = await translateProductText(input.lp_seo_title);
        const lp_seo_description = await translateProductText(input.lp_seo_description);


        const lp_description = await translateLexicalContent(input.lp_description);

        const languages = ["th", "en", "ja"] as const;

        let firstInsertId = 0;

        for (const lang of languages) {

            const data = {
                e_id: input.e_id,
                p_id: input.p_id,
                lp_title: lp_title[lang] ?? "",
                lp_description: lp_description[lang] ?? "",
                lp_imag_url: input.lp_imag_url,
                lp_seo_title: lp_seo_title[lang] ?? "",
                lp_seo_description: lp_seo_description[lang] ?? "",
                lp_slug: `${input.lp_slug}-${lang}`,
                lg_code: lang,
                group_id: groupId,
                st_id: input.st_id,
            };

            const [res] = await conn.query<ResultSetHeader>(
                `INSERT INTO LandingPages SET ?`,
                data
            );

            if (!firstInsertId) {
                firstInsertId = res.insertId;
            }
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

export async function UpdateLandingPage(input: LandingpageUpdateInput): Promise<number> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        input.update_at = new Date().toISOString();

        const [res] = await conn.query<ResultSetHeader>(
            `UPDATE LandingPages SET ? WHERE lp_id = ?`,
            [input, input.lp_id]
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

export async function DeleteLandingPage(group_id: number): Promise<void> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [res] = await conn.query<ResultSetHeader>(
            `DELETE FROM LandingPages WHERE group_id = ?`,
            [group_id]
        );
        if (res.affectedRows === 0) {
            throw new ApiError(404, CommonMessages.notFound);
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback();
        if (isFkConstraintError(err)) {
            throw new ApiError(409, CommonMessages.used);
        }
        throw err;
    } finally {
        conn.release();
    }
}


export async function GetLandingPageProductId(
    slug: string,
    lg_code: string
): Promise<LandingpageDTO | null> {
    const conn = await pool.getConnection()

    try {
        const [rows] = await conn.query<(RowDataPacket & LandingpageDTO)[]>(
            `SELECT a.*,c.p_name, 
            MIN(d.pv_price) AS min_price,
            MAX(d.pv_price) AS max_price,
            MAX(COALESCE(d.discount, 0)) AS discount,b.c_id
            From LandingPages a 
            INNER JOIN Products b 
            ON a.p_id = b.p_id
            INNER JOIN ProductLangs c 
            ON c.p_id = b.p_id
            INNER JOIN ProductVariants d
            ON d.p_id = a.p_id WHERE lp_slug = ? AND c.lg_code = ? LIMIT 1`,
            [slug, lg_code]
        )

        return rows[0] ?? null
    } catch (err) {
        throw err
    } finally {
        conn.release()
    }
}

export async function GetLandingPagesluge(): Promise<SlugDataresponse[]> {
    const conn = await pool.getConnection()

    try {
        const [rows] = await conn.query<(RowDataPacket & SlugDataresponse)[]>(
            `SELECT lp_slug FROM LandingPages`
        )

        return rows
    } catch (err) {
        throw err
    } finally {
        conn.release()
    }
}





