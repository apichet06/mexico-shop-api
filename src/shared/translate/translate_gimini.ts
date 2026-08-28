import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

const ai = new GoogleGenAI({ apiKey });

const translationJsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        es: { type: "string" },
        th: { type: "string" },
        en: { type: "string" },
        ja: { type: "string" },
    },
    required: ["es", "th", "en", "ja"],
} as const;

// ใช้ zod validate "หลังบ้าน" อีกชั้น (optional แต่ดี)
const TranslationSchema = z.object({
    es: z.string(),
    th: z.string(),
    en: z.string(),
    ja: z.string(),
});

export async function translateNameGimini(
    es: string,
    labelContext = "e-commerce category label"
): Promise<{ es: string; en: string; ja: string; th: string }> {
    const text = (es ?? "").trim();
    if (!text) return { es: "", en: "", ja: "", th: "" };

    const res = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
            {
                role: "user",
                parts: [
                    {
                        text: [
                            `Translate the Spanish ${labelContext} into en-US, Japanese, and Thai.`,
                            "Keep it short like a user-interface label.",
                            "Return ONLY JSON that matches the provided schema (no markdown, no extra keys).",
                            "",
                            `Spanish: ${text}`,
                            "",
                            "Context:",
                            `This text is a short ${labelContext} for a professional e-commerce platform.`,
                            "The business includes:",
                            "1) Premium curated health and lifestyle products.",
                            "2) Industrial factory and engineering products including:",
                            "- Die casting molds",
                            "- Metal molds",
                            "- Bolts, nuts, screws",
                            "- Engine components",
                            "- Machine parts, tools, and mechanical equipment",
                            "",
                            "Use proper industrial and technical terminology when applicable.",
                            "Avoid casual, food, or metaphorical meanings.",
                        ].join("\n"),
                    },
                ],
            },
        ],
        config: {
            responseMimeType: "application/json",
            responseSchema: translationJsonSchema, //  ใช้ตัวนี้ ชัวร์
            temperature: 0.2,
        },
    });

    const parsed = TranslationSchema.parse(JSON.parse(res.text ?? "{}")); //   validate
    return { es: text, en: parsed.en, ja: parsed.ja, th: parsed.th };
}
