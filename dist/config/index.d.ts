export declare const config: {
    NODE_ENV: "development" | "production" | "test";
    PORT: number;
    APP_BASE_PATH: string;
    DATABASE_PROVIDER: "sqlite" | "postgresql";
    DATABASE_URL: string;
    SESSION_SECRET: string;
    APP_ENCRYPTION_KEY: string;
    QR_EXPIRY_MINUTES: number;
    ADMIN_DEFAULT_USERNAME: string;
    ADMIN_DEFAULT_PASSWORD: string;
    ORKUT_BALANCE_BASE_URL?: string | undefined;
    ORKUT_QRIS_WEB_REPORT_URL_TEMPLATE?: string | undefined;
};
