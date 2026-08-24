import { extractImageSrcsFromLexical } from "./extractImageSrcsFromLexical.js";

export function filterUnusedImages(
    imageUrls: string[],
    otherDescriptions: string[]
): string[] {
    const usedImageSet = new Set<string>();

    for (const desc of otherDescriptions) {
        const srcs = extractImageSrcsFromLexical(desc);
        for (const src of srcs) {
            usedImageSet.add(src);
        }
    }

    return imageUrls.filter((url) => !usedImageSet.has(url));
}