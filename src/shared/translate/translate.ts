import * as deepl from "deepl-node";
import type { MultiLangText } from "../utils/ฺBase64Image/Lexical/LexicalFunction.js";
import { EN, ES, JA, TH, translator } from "./translate.client.js";


export async function translateProductText(es: string): Promise<MultiLangText> {
    const text = (es ?? "").trim();
    if (!text) return { es: "", en: "", ja: "", th: "" };

    // context ช่วยให้คำสั้นๆ แปลแม่นขึ้น (เช่น "สุขภาพ" จะไม่หลุดความหมาย) :contentReference[oaicite:2]{index=2}
    const options: deepl.TranslateTextOptions = {
        context: `
                Category name for a professional e-commerce platform.
                The business includes:
                1) Premium curated health and lifestyle products.
                2) Industrial factory goods including:
                - Die casting molds
                - Metal molds
                - Bolts, nuts, screws
                - Engine components
                - Machine parts and tools 
                Use correct industrial and technical terminology.
                Keep it concise like a category title.
                Avoid casual or metaphorical meaning.`,
    };

    const [enRes, jaRes, thRes] = await Promise.all([
        translator.translateText(text, ES, EN, options),
        translator.translateText(text, ES, JA, options),
        translator.translateText(text, ES, TH, options),
    ]);

    return {
        es: text,
        en: enRes.text,
        ja: jaRes.text,
        th: thRes.text,
    };
}
