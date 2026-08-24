import * as deepl from "deepl-node";
import { EN, JA, translator } from "./translate.client.js";

export async function translateProductFields(
    texts: string[]
): Promise<{ th: string[]; en: string[]; ja: string[] }> {
    const cleanTexts = texts.map((text) => (text ?? "").trim());
    const nonEmptyItems = cleanTexts
        .map((text, index) => ({ text, index }))
        .filter((item) => item.text.length > 0);

    if (nonEmptyItems.length === 0) {
        return {
            th: cleanTexts,
            en: cleanTexts.map(() => ""),
            ja: cleanTexts.map(() => ""),
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

    const [enRes, jaRes] = await Promise.all([
        translator.translateText(textsToTranslate, null, EN, options),
        translator.translateText(textsToTranslate, null, JA, options),
    ]);

    const en = cleanTexts.map(() => "");
    const ja = cleanTexts.map(() => "");

    enRes.forEach((result: any, translatedIndex: number) => {
        const originalIndex = nonEmptyItems[translatedIndex]?.index;
        if (originalIndex !== undefined) en[originalIndex] = result.text;
    });

    jaRes.forEach((result: any, translatedIndex: number) => {
        const originalIndex = nonEmptyItems[translatedIndex]?.index;
        if (originalIndex !== undefined) ja[originalIndex] = result.text;
    });

    return {
        th: cleanTexts,
        en,
        ja,
    };
}
