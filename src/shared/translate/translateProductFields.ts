import * as deepl from "deepl-node";
import { EN, ES, JA, TH, translator } from "./translate.client.js";
import { translateNameGimini } from "./translate_gimini.js";

function normalizeComparison(value: string): string {
    return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

export async function translateProductFields(
    texts: string[]
): Promise<{ es: string[]; en: string[]; ja: string[]; th: string[] }> {
    const cleanTexts = texts.map((text) => (text ?? "").trim());
    const nonEmptyItems = cleanTexts
        .map((text, index) => ({ text, index }))
        .filter((item) => item.text.length > 0);

    if (nonEmptyItems.length === 0) {
        return {
            es: cleanTexts,
            en: cleanTexts.map(() => ""),
            ja: cleanTexts.map(() => ""),
            th: cleanTexts.map(() => ""),
        };
    }

    const options: deepl.TranslateTextOptions = {
        context: `
      Product fields for a professional e-commerce platform.
      The business includes:
      1) Premium curated health and lifestyle products.
      2) Industrial factory goods including:
      - Die casting molds
      - Metal molds
      - Bolts, nuts, screws
      - Engine components
      - Machine parts and tools
      Use correct industrial and technical terminology.
      Keep wording concise and natural for e-commerce.
    `,
        preserveFormatting: true,
    };

    const textsToTranslate = nonEmptyItems.map((item) => item.text);

    const [enRes, jaRes, thRes] = await Promise.all([
        translator.translateText(textsToTranslate, ES, EN, options),
        translator.translateText(textsToTranslate, ES, JA, options),
        translator.translateText(textsToTranslate, ES, TH, options),
    ]);

    const en = cleanTexts.map(() => "");
    const ja = cleanTexts.map(() => "");
    const th = cleanTexts.map(() => "");

    enRes.forEach((result: any, translatedIndex: number) => {
        const originalIndex = nonEmptyItems[translatedIndex]?.index;
        if (originalIndex !== undefined) en[originalIndex] = result.text;
    });

    jaRes.forEach((result: any, translatedIndex: number) => {
        const originalIndex = nonEmptyItems[translatedIndex]?.index;
        if (originalIndex !== undefined) ja[originalIndex] = result.text;
    });
    thRes.forEach((result: any, translatedIndex: number) => {
        const originalIndex = nonEmptyItems[translatedIndex]?.index;
        if (originalIndex !== undefined) th[originalIndex] = result.text;
    });

    // DeepL อาจคืนคำอังกฤษในช่องภาษาไทยสำหรับคำสเปนสั้น ๆ เช่น prueba -> test
    // ใช้ Gemini เฉพาะรายการที่ผลไทยซ้ำกับอังกฤษ แต่ต้นฉบับสเปนไม่ได้เป็นคำเดียวกัน
    const suspiciousThaiIndexes = nonEmptyItems
        .map(({ text, index }) => ({ text, index }))
        .filter(({ text, index }) => {
            const source = normalizeComparison(text);
            const english = normalizeComparison(en[index] ?? "");
            const thai = normalizeComparison(th[index] ?? "");
            return thai.length > 0 && thai === english && source !== english;
        });

    const thaiFallbacks = await Promise.all(
        suspiciousThaiIndexes.map(({ text }) => translateNameGimini(text)),
    );

    suspiciousThaiIndexes.forEach(({ index }, fallbackIndex) => {
        th[index] = thaiFallbacks[fallbackIndex]?.th ?? th[index] ?? "";
    });

    return {
        es: cleanTexts,
        en,
        ja,
        th,
    };
}
