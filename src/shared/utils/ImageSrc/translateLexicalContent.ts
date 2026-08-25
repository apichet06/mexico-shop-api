import * as deepl from "deepl-node";
import { buildTranslatedEditorState, extractTextsFromEditorState, } from "./lexical.utils.js";
import { EN, ES, JA, TH, translator } from "../../translate/translate.client.js";
import type { LexicalEditorState, MultiLangLexical } from "./LexicalFunction.js";
import { IS_DEV } from "../../config/env.js";

//สำหรับการบันทึกรูปภาพในรูปแบบ SRC  ไม่ใช่แบบ image:Base64

export async function translateLexicalContent(
    input: LexicalEditorState | string,
): Promise<MultiLangLexical> {
    const editorState = normalizeLexicalInput(input);

    const sourceTexts = extractTextsFromEditorState(editorState);
    // if (IS_DEV) {
    //     console.log("📦 Raw Lexical Input:", JSON.stringify(editorState, null, 2));

    //     console.log("🔍 Extracted texts:");
    //     sourceTexts.forEach((t, i) => {
    //         console.log(`[${i}]`, t);
    //     });
    // }

    // ไม่มีข้อความให้แปล
    if (sourceTexts.length === 0) {
        const originalJson = JSON.stringify(editorState);
        return {
            es: originalJson,
            en: originalJson,
            ja: originalJson,
            th: originalJson,
        };
    }

    // มีแต่ string ว่าง
    const hasMeaningfulText = sourceTexts.some((text: string) => text.trim() !== "");
    if (!hasMeaningfulText) {
        const originalJson = JSON.stringify(editorState);
        return {
            es: originalJson,
            en: originalJson,
            ja: originalJson,
            th: originalJson,
        };
    }

    const options: deepl.TranslateTextOptions = {
        context: `
                Product description for a professional e-commerce platform.
                The business includes:
                1) Premium curated health and lifestyle products.
                2) Industrial factory goods such as molds, machine parts, tools, bolts, nuts, and engine components.
                Use correct product and industrial terminology where appropriate.
                Preserve the original meaning clearly.
                Do not translate image URLs, filenames, metadata, or layout fields.
        `.trim(),
        splitSentences: "nonewlines",
        preserveFormatting: true,
    };

    const [enRes, jaRes, thRes] = await Promise.all([
        translator.translateText(sourceTexts, ES, EN, options),
        translator.translateText(sourceTexts, ES, JA, options),
        translator.translateText(sourceTexts, ES, TH, options),
    ]);

    const enTexts = normalizeDeepLResult(enRes);
    const jaTexts = normalizeDeepLResult(jaRes);
    const thTexts = normalizeDeepLResult(thRes);

    // if (IS_DEV) {
    //     console.log("🌍 EN result:");
    //     enTexts.forEach((t, i) => {
    //         console.log(`[${i}]`, t);
    //     });

    //     console.log("🗾 JA result:");
    //     jaTexts.forEach((t, i) => {
    //         console.log(`[${i}]`, t);
    //     });

    //     console.log("🔄 Mapping TH → EN:");
    //     sourceTexts.forEach((src, i) => {
    //         console.log(`[${i}] ${src} → ${enTexts[i]}`);
    //     });

    //     console.log("🔄 Mapping TH → JA:");
    //     sourceTexts.forEach((src, i) => {
    //         console.log(`[${i}] ${src} → ${jaTexts[i]}`);
    //     });
    // }


    const enEditorState = buildTranslatedEditorState(editorState, enTexts);
    const jaEditorState = buildTranslatedEditorState(editorState, jaTexts);
    const thEditorState = buildTranslatedEditorState(editorState, thTexts);

    return {
        es: JSON.stringify(editorState),
        en: JSON.stringify(enEditorState),
        ja: JSON.stringify(jaEditorState),
        th: JSON.stringify(thEditorState),
    };
}

function normalizeLexicalInput(input: LexicalEditorState | string): LexicalEditorState {
    if (typeof input === "string") {
        return JSON.parse(input) as LexicalEditorState;
    }

    return input;
}

function normalizeDeepLResult(
    result: deepl.TextResult | deepl.TextResult[],
): string[] {
    if (Array.isArray(result)) {
        return result.map((item) => item.text);
    }

    return [result.text];
}
