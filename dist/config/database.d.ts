import { PrismaClient } from '@prisma/client';
export declare const db: PrismaClient<import(".prisma/client").Prisma.PrismaClientOptions, never, import("@prisma/client/runtime/library").DefaultArgs>;
/**
 * Initialize SQLite pragmas for optimal performance.
 * Must be called once at startup before accepting requests.
 */
export declare function initDatabase(): Promise<void>;
