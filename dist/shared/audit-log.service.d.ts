import type { PrismaClient } from '@prisma/client';
interface AuditLogOptions {
    userId?: string | null;
    action: string;
    entityType?: string;
    entityId?: string;
    detail?: Record<string, unknown>;
    ip?: string;
}
/**
 * Writes an entry to the audit_log table.
 * Fire-and-forget safe — errors are swallowed so they never break the caller.
 */
export declare function writeAuditLog(db: PrismaClient, opts: AuditLogOptions): Promise<void>;
export {};
