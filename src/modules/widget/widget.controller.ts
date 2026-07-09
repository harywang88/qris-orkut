import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { generateQr, NoEligibleAccountError, AccountFullError } from '../../shared/qris-generator.service';
import { getTransactionByQrId } from '../transactions/transactions.service';
import { findClientByWidgetKey, isOriginAllowed } from './widget.service';
import { logger } from '../../config/logger';
import { RateLimiter } from '../../core/rate-limit';

// Batasi pembuatan QR: maks 5 per menit per (widgetKey + IP). Endpoint ini
// publik (hanya dijaga key + Origin, dan Origin bisa dipalsukan dari script),
// jadi ini pertahanan dasar anti-spam pembuatan QR massal.
const generateLimiter = new RateLimiter({ windowMs: 60_000, max: 5 });

/**
 * Ambil IP ASLI client. Di depan app ada Cloudflare + nginx, jadi req.ip
 * malah berisi IP edge Cloudflare yang BERUBAH-UBAH tiap request (bikin
 * rate-limit tak pernah kena). IP client asli ada di elemen PERTAMA
 * X-Forwarded-For: "clientAsli, cfEdge, ...". Fallback ke req.ip.
 */
function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (raw) {
    const first = raw.split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Sets permissive-but-scoped CORS headers for the widget endpoints.
 * Echoes back the caller's Origin when present so browsers accept the response.
 */
function setWidgetCors(req: Request, res: Response): void {
  const origin = req.headers.origin as string | undefined;
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * GET /widget/generate?key=…&amount=…&member=…&ref=…
 *
 * Public, browser-facing (alfael-style). Authenticated only by the widget key
 * plus an Origin/Referer allowlist. Creates a QR for the client that owns the key.
 */
export async function handleWidgetGenerate(req: Request, res: Response): Promise<void> {
  setWidgetCors(req, res);

  try {
    const key = String(req.query.key ?? '');
    const client = await findClientByWidgetKey(key);
    if (!client) {
      res.status(401).json({ success: false, error: 'Widget key tidak valid' });
      return;
    }

    if (!isOriginAllowed(client.widgetAllowedOrigins, req.headers.origin as string | undefined, req.headers.referer)) {
      logger.warn(
        { clientId: client.id, origin: req.headers.origin, referer: req.headers.referer },
        'Widget generate blocked by origin allowlist',
      );
      res.status(403).json({ success: false, error: 'Origin tidak diizinkan' });
      return;
    }

    // Rate limit per (widgetKey + IP). Dicek SETELAH key & origin valid supaya
    // request sah tidak terganggu request bermasalah dari IP/kunci lain.
    const rl = generateLimiter.check(`${client.id}:${clientIp(req)}`);
    if (!rl.allowed) {
      const retrySec = Math.ceil(rl.retryAfterMs / 1000);
      logger.warn(
        { clientId: client.id, ip: clientIp(req), retrySec },
        'Widget generate rate-limited',
      );
      res.setHeader('Retry-After', String(retrySec));
      res.status(429).json({
        success: false,
        error: `Terlalu banyak permintaan. Coba lagi dalam ${retrySec} detik.`,
      });
      return;
    }

    const amount = parseInt(String(req.query.amount ?? ''), 10);
    const member = String(req.query.member ?? '').trim();
    const ref = req.query.ref ? String(req.query.ref) : undefined;

    const output = await generateQr(client.id, {
      userId: member || 'guest',
      amount,
      externalReference: ref,
    });

    res.status(201).json({ success: true, data: output });
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ success: false, error: 'Input tidak valid', details: err.flatten().fieldErrors });
      return;
    }
    if (err instanceof NoEligibleAccountError) {
      res.status(503).json({ success: false, error: 'Tidak ada akun QRIS tersedia saat ini. Silakan coba lagi.' });
      return;
    }
    if (err instanceof AccountFullError) {
      res.status(503).json({ success: false, error: 'Kapasitas akun QRIS penuh saat ini. Silakan coba lagi.' });
      return;
    }
    logger.error({ err }, 'handleWidgetGenerate error');
    res.status(500).json({ success: false, error: 'Terjadi kesalahan internal' });
  }
}

/**
 * GET /widget/status?key=…&qrId=…
 *
 * Returns minimal payment status. The QR must belong to the client that owns
 * the widget key (prevents one site reading another site's transactions).
 */
export async function handleWidgetStatus(req: Request, res: Response): Promise<void> {
  setWidgetCors(req, res);

  try {
    const key = String(req.query.key ?? '');
    const client = await findClientByWidgetKey(key);
    if (!client) {
      res.status(401).json({ success: false, error: 'Widget key tidak valid' });
      return;
    }

    const qrId = String(req.query.qrId ?? '').trim();
    if (!qrId) {
      res.status(400).json({ success: false, error: 'qrId wajib diisi' });
      return;
    }

    const tx = await getTransactionByQrId(qrId);
    if (!tx || tx.clientId !== client.id) {
      res.status(404).json({ success: false, error: 'Transaksi tidak ditemukan' });
      return;
    }

    res.json({
      success: true,
      data: {
        qrId: tx.qrId,
        statusPay: tx.statusPay,
        statusBot: tx.statusBot,
        finalAmount: tx.finalAmount,
        expiresAt: tx.expiresAt.toISOString(),
        paidAt: tx.paidAt ? tx.paidAt.toISOString() : null,
      },
    });
  } catch (err) {
    logger.error({ err }, 'handleWidgetStatus error');
    res.status(500).json({ success: false, error: 'Terjadi kesalahan internal' });
  }
}

/** Handles CORS preflight for the widget endpoints. */
export function handleWidgetOptions(req: Request, res: Response): void {
  setWidgetCors(req, res);
  res.status(204).end();
}
