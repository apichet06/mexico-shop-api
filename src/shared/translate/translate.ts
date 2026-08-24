import * as deepl from "deepl-node";
import type { MultiLangText } from "../utils/ฺBase64Image/Lexical/LexicalFunction.js";
import { EN, JA, translator } from "./translate.client.js";


export async function translateProductText(th: string): Promise<MultiLangText> {
    const text = (th ?? "").trim();
    if (!text) return { th: "", en: "", ja: "" };

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

    // แปล 2 ภาษา (th คืนค่าเดิม)
    const [enRes, jaRes] = await Promise.all([
        translator.translateText(text, null, EN, options),
        translator.translateText(text, null, JA, options),
    ]);

    return {
        th: text,
        en: enRes.text,
        ja: jaRes.text,
    };
}
