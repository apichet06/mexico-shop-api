import { prepareLexicalImages } from "./prepareLexicalImages.js";

export function transformLexicalDescription(
    p_description: string,
    apiBaseUrl: string
) {
    const parsed = JSON.parse(p_description);

    if (!parsed?.root) {
        throw new Error("Invalid Lexical description: missing root");
    }

    const replacedCount = prepareLexicalImages(parsed.root, apiBaseUrl);

    // console.log("replacedCount:", replacedCount);
    // console.log("after parsed:", JSON.stringify(parsed, null, 2));

    return JSON.stringify(parsed);
}