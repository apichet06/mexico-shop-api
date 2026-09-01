import "dotenv/config";

function must(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

export const env = {
    NODE_ENV: process.env.NODE_ENV ?? "development",
    PORT: Number(process.env.PORT ?? 5000),

    DB_HOST: must("DB_HOST"),
    DB_USER: must("DB_USER"),
    DB_PASSWORD: must("DB_PASSWORD"),
    DB_NAME: must("DB_NAME"),
    DB_PORT: Number(process.env.DB_PORT ?? 3306),

    MERCADO_PAGO_ACCESS_TOKEN: process.env.MERCADO_PAGO_ACCESS_TOKEN,
    MERCADO_PAGO_WEBHOOK_SECRET: process.env.MERCADO_PAGO_WEBHOOK_SECRET,
};
