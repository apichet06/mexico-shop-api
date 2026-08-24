export function collectImageSrcs(node: any, results: string[] = []): string[] {
    if (!node) return results;

    if (node.root) {
        collectImageSrcs(node.root, results);
    }

    if (node.type === "image" && typeof node.src === "string") {
        results.push(node.src);
    }

    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            collectImageSrcs(child, results);
        }
    }

    return results;
}