"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const zod_1 = require("zod");
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config({ path: path_1.default.join(process.cwd(), '.env'), override: true });
const envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'production', 'test']).default('development'),
    PORT: zod_1.z.coerce.number().default(3333),
    APP_BASE_PATH: zod_1.z.string().default('/qris'),
    DATABASE_PROVIDER: zod_1.z.enum(['sqlite', 'postgresql']).default('sqlite'),
    DATABASE_URL: zod_1.z.string().min(1, 'DATABASE_URL is required'),
    SESSION_SECRET: zod_1.z.string().min(16, 'SESSION_SECRET must be at least 16 chars'),
    APP_ENCRYPTION_KEY: zod_1.z
        .string()
        .length(64, 'APP_ENCRYPTION_KEY must be exactly 64 hex chars (32 bytes)'),
    QR_EXPIRY_MINUTES: zod_1.z.coerce.number().default(12),
    ADMIN_DEFAULT_USERNAME: zod_1.z.string().default('admin'),
    ADMIN_DEFAULT_PASSWORD: zod_1.z.string().default('ChangeMe123!'),
    ORKUT_BALANCE_BASE_URL: zod_1.z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), zod_1.z.string().url().optional()),
    ORKUT_QRIS_WEB_REPORT_URL_TEMPLATE: zod_1.z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), zod_1.z.string().url().or(zod_1.z.string().includes('{account}')).optional()),
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error('❌ Invalid environment variables:');
    const errors = parsed.error.flatten().fieldErrors;
    for (const [field, messages] of Object.entries(errors)) {
        console.error(`  ${field}: ${(messages ?? []).join(', ')}`);
    }
    process.exit(1);
}
exports.config = parsed.data;
//# sourceMappingURL=index.js.map