"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeAuditLog = writeAuditLog;
/**
 * Writes an entry to the audit_log table.
 * Fire-and-forget safe — errors are swallowed so they never break the caller.
 */
async function writeAuditLog(db, opts) {
    try {
        await db.auditLog.create({
            data: {
                userId: opts.userId ?? null,
                action: opts.action,
                entityType: opts.entityType ?? null,
                entityId: opts.entityId ?? null,
                detailJson: opts.detail ? JSON.stringify(opts.detail) : null,
                ipAddress: opts.ip ?? null,
            },
        });
    }
    catch {
        // Audit log failures must never block the main operation
    }
}
//# sourceMappingURL=audit-log.service.js.map