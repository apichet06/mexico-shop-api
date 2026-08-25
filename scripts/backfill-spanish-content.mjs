import { pool } from "../dist/db/pool.js";
import { translator } from "../dist/shared/translate/translate.client.js";
import {
    buildTranslatedEditorState,
    extractTextsFromEditorState,
} from "../dist/shared/utils/ImageSrc/lexical.utils.js";

const applyChanges = process.argv.includes("--apply");

function translatedTexts(result) {
    return Array.isArray(result) ? result.map((item) => item.text) : [result.text];
}

async function translateFields(values) {
    const source = values.map((value) => String(value ?? "").trim());
    const populated = source.map((text, index) => ({ text, index })).filter((item) => item.text);
    const output = source.map(() => "");

    if (populated.length === 0) return output;

    const result = await translator.translateText(
        populated.map((item) => item.text),
        "en",
        "es",
        {
            preserveFormatting: true,
            context: "Professional Mexican e-commerce catalog content. Use natural Mexican Spanish.",
        },
    );

    translatedTexts(result).forEach((text, translatedIndex) => {
        output[populated[translatedIndex].index] = text;
    });
    return output;
}

async function translateRichText(value) {
    const source = String(value ?? "");
    if (!source.trim()) return source;

    try {
        const editorState = JSON.parse(source);
        const texts = extractTextsFromEditorState(editorState);
        if (texts.length === 0 || !texts.some((text) => text.trim())) return source;

        const result = await translator.translateText(texts, "en", "es", {
            preserveFormatting: true,
            context: "Professional Mexican e-commerce content. Use natural Mexican Spanish.",
        });
        return JSON.stringify(buildTranslatedEditorState(editorState, translatedTexts(result)));
    } catch {
        return (await translateFields([source]))[0];
    }
}

function spanishSlug(slug) {
    const value = String(slug ?? "").trim();
    if (!value) return value;
    if (/-en$/i.test(value)) return value.replace(/-en$/i, "-es");
    return `${value}-es`;
}

async function missingRows(table, identityColumn) {
    const [rows] = await pool.query(
        `SELECT source.* FROM ${table} source
         WHERE source.lg_code = 'en'
           AND NOT EXISTS (
               SELECT 1 FROM ${table} target
               WHERE target.${identityColumn} = source.${identityColumn}
                 AND target.lg_code = 'es'
           )`,
    );
    return rows;
}

async function hasIndex(tableName, indexName) {
    const [rows] = await pool.query(
        `SELECT 1 FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
         LIMIT 1`,
        [tableName, indexName],
    );
    return rows.length > 0;
}

async function ensureLanguageScopedUniqueIndexes() {
    if (await hasIndex("CategoryLangs", "cl_name_UNIQUE")) {
        await pool.query(
            `ALTER TABLE CategoryLangs
             DROP INDEX cl_name_UNIQUE,
             ADD UNIQUE KEY uq_category_lang_name (lg_code, cl_name)`,
        );
    }
    if (await hasIndex("ProductTagLangs", "ptag_name_UNIQUE")) {
        await pool.query(
            `ALTER TABLE ProductTagLangs
             DROP INDEX ptag_name_UNIQUE,
             ADD UNIQUE KEY uq_product_tag_lang_name (lg_code, ptag_name)`,
        );
    }
}

async function main() {
    const [products, articles, landingPages, categories, tags, units] = await Promise.all([
        missingRows("ProductLangs", "p_id"),
        missingRows("Articles", "group_id"),
        missingRows("LandingPages", "group_id"),
        missingRows("CategoryLangs", "c_id"),
        missingRows("ProductTagLangs", "ptag_id"),
        missingRows("UnitLangs", "u_id"),
    ]);

    const counts = {
        ProductLangs: products.length,
        Articles: articles.length,
        LandingPages: landingPages.length,
        CategoryLangs: categories.length,
        ProductTagLangs: tags.length,
        UnitLangs: units.length,
    };
    console.log(applyChanges ? "Applying Spanish backfill:" : "Spanish backfill dry run:", counts);
    if (!applyChanges) return;

    await ensureLanguageScopedUniqueIndexes();

    const prepared = {
        products: [], articles: [], landingPages: [], categories: [], tags: [], units: [],
    };

    for (const row of products) {
        const [name, title] = await translateFields([row.p_name, row.p_title]);
        prepared.products.push({ ...row, p_name: name, p_title: title, p_description: await translateRichText(row.p_description) });
    }
    for (const row of articles) {
        const [title, summary, seoTitle, seoDescription] = await translateFields([
            row.art_title, row.art_summary, row.art_seo_title, row.art_seo_description,
        ]);
        prepared.articles.push({
            ...row,
            art_title: title,
            art_summary: summary,
            art_content: await translateRichText(row.art_content),
            art_seo_title: seoTitle,
            art_seo_description: seoDescription,
            art_slug: spanishSlug(row.art_slug),
        });
    }
    for (const row of landingPages) {
        const [title, seoTitle, seoDescription] = await translateFields([
            row.lp_title, row.lp_seo_title, row.lp_seo_description,
        ]);
        prepared.landingPages.push({
            ...row,
            lp_title: title,
            lp_description: await translateRichText(row.lp_description),
            lp_seo_title: seoTitle,
            lp_seo_description: seoDescription,
            lp_slug: spanishSlug(row.lp_slug),
        });
    }

    const categoryNames = await translateFields(categories.map((row) => row.cl_name));
    prepared.categories = categories.map((row, index) => ({ ...row, cl_name: categoryNames[index] }));
    const tagNames = await translateFields(tags.map((row) => row.ptag_name));
    prepared.tags = tags.map((row, index) => ({ ...row, ptag_name: tagNames[index] }));
    const unitNames = await translateFields(units.map((row) => row.ul_name));
    prepared.units = units.map((row, index) => ({ ...row, ul_name: unitNames[index] }));

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.query(
            `INSERT INTO Languages (lg_code, ig_image_url, lg_fullname)
             VALUES ('es', NULL, 'Español')
             ON DUPLICATE KEY UPDATE lg_fullname = VALUES(lg_fullname)`,
        );

        for (const row of prepared.products) {
            await connection.query(
                `INSERT INTO ProductLangs (p_title, p_name, p_description, p_id, lg_code)
                 VALUES (?, ?, ?, ?, 'es')`,
                [row.p_title, row.p_name, row.p_description, row.p_id],
            );
        }
        for (const row of prepared.articles) {
            await connection.query(
                `INSERT INTO Articles
                 (art_title, art_summary, art_content, art_image_url, art_slug, art_seo_title,
                  art_seo_description, art_published_at, lg_code, group_id, st_id, e_id, art_show_home)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'es', ?, ?, ?, ?)`,
                [row.art_title, row.art_summary, row.art_content, row.art_image_url, row.art_slug,
                    row.art_seo_title, row.art_seo_description, row.art_published_at,
                    row.group_id, row.st_id, row.e_id, row.art_show_home],
            );
        }
        for (const row of prepared.landingPages) {
            await connection.query(
                `INSERT INTO LandingPages
                 (lp_description, lp_title, lp_imag_url, lp_seo_title, lp_seo_description,
                  lp_slug, e_id, p_id, lg_code, st_id, group_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'es', ?, ?)`,
                [row.lp_description, row.lp_title, row.lp_imag_url, row.lp_seo_title,
                    row.lp_seo_description, row.lp_slug, row.e_id, row.p_id, row.st_id, row.group_id],
            );
        }
        for (const row of prepared.categories) {
            await connection.query(
                "INSERT INTO CategoryLangs (cl_name, c_id, lg_code) VALUES (?, ?, 'es')",
                [row.cl_name, row.c_id],
            );
        }
        for (const row of prepared.tags) {
            await connection.query(
                "INSERT INTO ProductTagLangs (ptag_name, ptag_id, lg_code) VALUES (?, ?, 'es')",
                [row.ptag_name, row.ptag_id],
            );
        }
        for (const row of prepared.units) {
            await connection.query(
                "INSERT INTO UnitLangs (ul_name, u_id, lg_code) VALUES (?, ?, 'es')",
                [row.ul_name, row.u_id],
            );
        }

        await connection.commit();
        console.log("Spanish content backfill completed.");
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

try {
    await main();
} finally {
    await pool.end();
}
