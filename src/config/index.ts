import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env'), override: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3333),
  APP_BASE_PATH: z.string().default('/qris'),
  DATABASE_PROVIDER: z.enum(['sqlite', 'postgresql']).default('sqlite'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 chars'),
  APP_ENCRYPTION_KEY: z
    .string()
    .length(64, 'APP_ENCRYPTION_KEY must be exactly 64 hex chars (32 bytes)'),
  QR_EXPIRY_MINUTES: z.coerce.number().default(12),
  ADMIN_DEFAULT_USERNAME: z.string().default('admin'),
  ADMIN_DEFAULT_PASSWORD: z.string().default('ChangeMe123!'),
  ORKUT_BALANCE_BASE_URL: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional(),
  ),
  ORKUT_QRIS_WEB_REPORT_URL_TEMPLATE: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().or(z.string().includes('{account}')).optional(),
  ),
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

export const config = parsed.data;
