import { isBase64Image } from "./isBase64Image.js";
import { saveBase64Image } from "./saveBase64Image.js";

type LexicalNode = {
    type?: string;
    src?: string;
    children?: LexicalNode[];
    [key: string]: any;
};

export function prepareLexicalImages(
    node: LexicalNode,
    apiBaseUrl: string
): number {
    let replacedCount = 0;

    // console.log("visiting node type:", node?.type);

    if (node.type === "image" && typeof node.src === "string") {
        // console.log("found image src:", node.src.slice(0, 30));

        if (isBase64Image(node.src)) {
            // console.log("base64 matched");

            const saved = saveBase64Image({
                base64: node.src,
                folderName: "editor",
                apiBaseUrl,
            });

            node.src = saved.relativePath;
            replacedCount++;

            // console.log("replaced src:", node.src);
        } else {
            console.log("not base64");
        }
    }

    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            replacedCount += prepareLexicalImages(child, apiBaseUrl);
        }
    }

    return replacedCount;
}
