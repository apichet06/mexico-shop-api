export type OptionType = {
    otype_id: number;
    otype_code: string;
    otype_name: string;
}

export type OptionTypeInput = Pick<OptionType, "otype_code" | "otype_name">;
