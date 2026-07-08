import type { PrismaClient } from '@prisma/client';
import type { Request } from 'express';
import { db } from '../config/database';

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
export async function writeAuditLog(
  db: PrismaClient,
  opts: AuditLogOptions,
): Promise<void> {
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
  } catch {
    // Audit log failures must never block the main operation
  }
}


// ── Admin Log: helper terpusat mencatat aksi (Fase 1) ────────────────────────
export type LogActionOpts = {
  category: string;                              // auth|account|site|merchant|settlement|generate-qr|client|rbac|sync
  action: string;                                // kode aksi mesin, mis. 'account_delete'
  summary: string;                               // kalimat Indonesia siap-tampil
  status?: 'success' | 'failed';
  severity?: 'info' | 'important' | 'critical';
  targetType?: string;
  targetId?: string;
  targetName?: string;
  before?: unknown;
  after?: unknown;
  detail?: Record<string, unknown>;
};

function pickClientIp(req: Request): string | null {
  const h = (req && req.headers) || ({} as Record<string, unknown>);
  const cf = h['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const xff = h['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return (req && req.ip) || null;
}

/**
 * Catat satu aksi admin ke audit_log. Fire-and-forget: gagal mencatat TIDAK
 * pernah menggagalkan aksi utama. Operator + IP diambil otomatis dari req.
 */
export async function logAction(req: Request, opts: LogActionOpts): Promise<void> {
  try {
    const sess = (req as unknown as { session?: { user?: { id?: string; username?: string; name?: string } } }).session;
    const user = sess?.user;
    const detail: Record<string, unknown> = { ...(opts.detail || {}) };
    if (opts.before !== undefined) detail.before = opts.before;
    if (opts.after !== undefined) detail.after = opts.after;
    await db.auditLog.create({
      data: {
        userId: user?.id ?? null,
        actorName: user?.username ?? user?.name ?? null,
        action: opts.action,
        category: opts.category,
        summary: opts.summary,
        status: opts.status ?? 'success',
        severity: opts.severity ?? 'info',
        entityType: opts.targetType ?? null,
        entityId: opts.targetId ?? null,
        targetName: opts.targetName ?? null,
        detailJson: Object.keys(detail).length ? JSON.stringify(detail) : null,
        ipAddress: pickClientIp(req),
      },
    });
  } catch {
    // fire-and-forget: audit gagal tak boleh ganggu operasi utama
  }
}
