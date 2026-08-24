import * as deepl from "deepl-node";

const authKey = process.env.DEEPL_AUTH_KEY;
if (!authKey) throw new Error("Missing DEEPL_AUTH_KEY");

export const translator = new deepl.Translator(authKey, {
    // ถ้าเป็น Free key จะยิงไป api-free (บางเวอร์ชันเลือกเองอัตโนมัติ)
    serverUrl: process.env.DEEPL_IS_FREE === "true"
        ? "https://api-free.deepl.com"
        : "https://api.deepl.com",
});

export const EN: deepl.TargetLanguageCode = "en-US";
export const JA: deepl.TargetLanguageCode = "ja";