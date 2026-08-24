import type { LexicalEditorState, LexicalNode } from "./LexicalFunction.js";

/**
 * clone JSON-safe object
 */
export function deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * ตรวจว่าเป็น text node ที่ต้องแปล
 */
export function isTranslatableTextNode(node: LexicalNode): boolean {
    return node.type === "text" && typeof node.text === "string";
}

/**
 * ตรวจว่าเป็น node ที่ควรข้าม logic translation โดยตรง
 * (จริงๆ ไม่จำเป็นต้องมี function นี้ก็ได้ แต่มีไว้ให้ภาพชัด)
 */
export function isIgnoredNode(node: LexicalNode): boolean {
    return node.type === "image";
}

/**
 * เก็บข้อความทั้งหมดจาก text nodes ตามลำดับ
 * - ignore image node
 * - ignore src/altText/layout fields อัตโนมัติ เพราะเราไม่อ่าน field พวกนั้น
 */
export function collectTranslatableTexts(
    node: LexicalNode,
    bucket: string[] = [],
): string[] {
    if (isIgnoredNode(node)) {
        return bucket;
    }

    if (isTranslatableTextNode(node)) {
        bucket.push(node.text ?? "");
    }

    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            collectTranslatableTexts(child, bucket);
        }
    }

    return bucket;
}

/**
 * เอาข้อความที่แปลแล้ว replace กลับเข้า text node ตามลำดับเดิม
 */
export function replaceTranslatedTexts(
    node: LexicalNode,
    translatedTexts: string[],
    cursor: { index: number },
): void {
    if (isIgnoredNode(node)) {
        return;
    }

    if (isTranslatableTextNode(node)) {
        const translated = translatedTexts[cursor.index];

        if (translated === undefined) {
            throw new Error(`Missing translated text at index ${cursor.index}`);
        }

        node.text = translated;
        cursor.index += 1;
    }

    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            replaceTranslatedTexts(child, translatedTexts, cursor);
        }
    }
}

/**
 * helper สำหรับ extract จาก editorState
 */
export function extractTextsFromEditorState(editorState: LexicalEditorState): string[] {
    return collectTranslatableTexts(editorState.root);
}

/**
 * helper สำหรับ rebuild editorState
 */
export function buildTranslatedEditorState(
    original: LexicalEditorState,
    translatedTexts: string[],
): LexicalEditorState {
    const cloned = deepClone(original);
    const originalTexts = extractTextsFromEditorState(original);

    if (originalTexts.length !== translatedTexts.length) {
        throw new Error(
            `Translated text count mismatch. expected=${originalTexts.length}, actual=${translatedTexts.length}`
        );
    }

    replaceTranslatedTexts(cloned.root, translatedTexts, { index: 0 });

    return cloned;
}