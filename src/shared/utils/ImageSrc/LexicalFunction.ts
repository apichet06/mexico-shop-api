export type MultiLangLexical = {
    th: string;
    en: string;
    ja: string;
};

export type LexicalNode = {
    type: string;
    text?: string;
    children?: LexicalNode[];

    [key: string]: unknown;
};

export type LexicalEditorState = {
    root: LexicalNode;
};