import { translateProductText } from "../../../translate/translate.js";

export type LexicalNode = {
    type?: string;
    text?: string;
    children?: LexicalNode[];
    [key: string]: unknown;
};

export type LexicalRoot = {
    root?: LexicalNode;
    [key: string]: unknown;
};

export type MultiLangText = {
    es: string;
    th: string;
    en: string;
    ja: string;
};

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

export function deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
}

export function parseLexicalJson(input: string | object | null | undefined): LexicalRoot | null {
    if (!input) return null;

    try {
        const parsed = typeof input === "string" ? JSON.parse(input) : input;
        if (!isObject(parsed)) return null;
        return parsed as LexicalRoot;
    } catch {
        return null;
    }
}

// 2) หา text node ทั้งหมด อันนี้จะเก็บ reference ของ node ที่เป็น type === "text" เท่านั้น ดังนั้น image node จะไม่ถูกแตะเลย
export function collectTextNodes(node: unknown, result: LexicalNode[] = []): LexicalNode[] {
    if (!isObject(node)) return result;

    const lexicalNode = node as LexicalNode;

    if (lexicalNode.type === "text" && typeof lexicalNode.text === "string") {
        result.push(lexicalNode);
    }

    if (Array.isArray(lexicalNode.children)) {
        for (const child of lexicalNode.children) {
            collectTextNodes(child, result);
        }
    }

    return result;
}

//3) รวมข้อความออกมาเป็น plain text สำหรับส่งแปล เราจะส่ง text node ทีละตัวก็ได้ แต่ถ้าเยอะมากจะยิง API หลายครั้ง 
// วิธีที่ practical กว่าคือรวมเป็นก้อนเดียวด้วย delimiter ที่ไม่น่าไปชนข้อความจริง แล้วค่อย split กลับ
const TEXT_SEPARATOR = "\n[[[LEXICAL_TEXT_SEPARATOR]]]\n";
export function joinTextNodesForTranslation(nodes: LexicalNode[]): string {
    return nodes
        .map((node) => (typeof node.text === "string" ? node.text : ""))
        .join(TEXT_SEPARATOR);
}

// 4) ใส่ข้อความกลับเข้า text node
export function replaceTextNodes(nodes: LexicalNode[], translatedParts: string[]) {
    if (nodes.length !== translatedParts.length) {
        throw new Error(
            `Translated parts count mismatch. expected=${nodes.length}, actual=${translatedParts.length}`
        );
    }

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const text = translatedParts[i];

        if (!node || text === undefined) {
            throw new Error(`Mapping error at index ${i}`);
        }
        node.text = text;
    }
}

export function splitTranslatedTextSafely(translatedText: string, expectedCount: number): string[] {
    const parts = translatedText.split(TEXT_SEPARATOR);

    if (parts.length === expectedCount) {
        return parts;
    }

    if (expectedCount === 1) {
        return [translatedText];
    }

    throw new Error(
        `Separator mismatch after translation. expected=${expectedCount}, actual=${parts.length}`
    );
}

export async function translateLexicalContent(
    input: string | object | null | undefined
): Promise<{ es: string; en: string; ja: string; th: string }> {
    const parsed = parseLexicalJson(input);

    if (!parsed || !parsed.root) {
        return { es: "", en: "", ja: "", th: "" };
    }

    const esJson = deepClone(parsed);
    const enJson = deepClone(parsed);
    const jaJson = deepClone(parsed);
    const thJson = deepClone(parsed);

    const esTextNodes = collectTextNodes(esJson.root);
    const enTextNodes = collectTextNodes(enJson.root);
    const jaTextNodes = collectTextNodes(jaJson.root);
    const thTextNodes = collectTextNodes(thJson.root);

    if (esTextNodes.length === 0) {
        return {
            es: JSON.stringify(esJson),
            en: JSON.stringify(enJson),
            ja: JSON.stringify(jaJson),
            th: JSON.stringify(thJson),
        };
    }

    const joinedSpanishText = joinTextNodesForTranslation(esTextNodes);
    const translated = await translateProductText(joinedSpanishText);

    // ใช้ตรงนี้
    const enParts = splitTranslatedTextSafely(translated.en, enTextNodes.length);
    const jaParts = splitTranslatedTextSafely(translated.ja, jaTextNodes.length);
    const thParts = splitTranslatedTextSafely(translated.th, thTextNodes.length);

    replaceTextNodes(enTextNodes, enParts);
    replaceTextNodes(jaTextNodes, jaParts);
    replaceTextNodes(thTextNodes, thParts);

    return {
        es: JSON.stringify(esJson),
        en: JSON.stringify(enJson),
        ja: JSON.stringify(jaJson),
        th: JSON.stringify(thJson),
    };
}

//ปกติถ้า editor นี้เก็บ content ไทยอยู่แล้ว การดึง text node ก็พอ
// แต่ถ้าคุณอยากกรองให้เอาเฉพาะข้อความที่มีตัวอักษรไทยจริง ๆ ก็เพิ่ม filter ได้

export function containsThai(text: string): boolean {
    return /[\u0E00-\u0E7F]/.test(text);
}
