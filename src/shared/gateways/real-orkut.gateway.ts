import crypto from 'crypto';
import type { QrisAccount } from '@prisma/client';
import { decrypt } from '../../core/encryption';
import { logger } from '../../config/logger';
import { classifyOrkutMutationDescription } from '../orkut-panel.service';
import type {
  IOrkutGateway,
  QrGenerationResult,
  RecheckResult,
  RawMutation,
} from './gateway.interface';

const ORKUT_BASE = 'https://orderkuota.com';
const MUTATION_PATH = '/akun/riwayat-saldo';

// ── HTML helpers ─────────────────────────────────────────────────────────────

function parseAmount(str: string): number {
  // "3.400.000" → 3400000
  return parseInt(str.replace(/\./g, '').replace(',', '').trim(), 10) || 0;
}

function parseOrkutDate(str: string): Date {
  // "23/03/2026 19:47" or "23/03/2026 19:47:22" → Date (WIB = UTC+7)
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return new Date();
  const [, dd, mm, yyyy, HH, MM, SS = '00'] = m;
  return new Date(`${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}+07:00`);
}

function extractRef(description: string): string | undefined {
  const m = description.match(/(?:R#|RRN[:#\s]?|REF[:#\s]?)(\d+)/i);
  return m ? m[1] : undefined;
}

/**
 * Parses the desktop HTML table from orderkuota.com /akun/riwayat-saldo.
 * Returns ALL rows: Pencairan QRIS (credit), Biaya (debit), Pindah Saldo (debit).
 *
 * Table columns: Tanggal | Keterangan | Debet | Kredit | Saldo Akhir
 */
function parseOrkutHtml(html: string): RawMutation[] {
  const tbodyMatch = html.match(/<tbody[^>]*id="history_transaksi"[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) {
    logger.warn('orkut-gateway: <tbody id="history_transaksi"> not found — cookies may be invalid');
    return [];
  }

  const mutations: RawMutation[] = [];
  const rowRe = /<tr>([\s\S]*?)<\/tr>/gi;
  let rowM: RegExpExecArray | null;

  while ((rowM = rowRe.exec(tbodyMatch[1])) !== null) {
    const tds: string[] = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdM: RegExpExecArray | null;
    while ((tdM = tdRe.exec(rowM[1])) !== null) {
      tds.push(tdM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    }
    if (tds.length < 5) continue;

    const [dateStr, description, debetStr, kreditStr, balanceStr] = tds;
    const debet       = parseAmount(debetStr);
    const kredit      = parseAmount(kreditStr);
    const balanceAfter = parseAmount(balanceStr);

    // Skip rows with no movement at all
    if (debet === 0 && kredit === 0) continue;

    const isCredit    = kredit > 0;
    const amount      = isCredit ? kredit : debet;
    const walletCategory = classifyOrkutMutationDescription(description);
    const rawDataJson = JSON.stringify({
      date: dateStr,
      description,
      debet,
      kredit,
      balanceAfter,
      displayTime: dateStr,
      status: isCredit ? 'IN' : 'OUT',
      walletCategory,
    });
    const rawHash     = crypto.createHash('sha256').update(`orkut:${description}:${dateStr}`).digest('hex');

    mutations.push({
      amount,
      type:            isCredit ? 'credit' : 'debit',
      balanceBefore:   isCredit ? balanceAfter - kredit + debet : balanceAfter + debet - kredit,
      balanceAfter,
      issuerName:      'Orderkuota QRIS',
      rrn:             extractRef(description),
      transactionTime: parseOrkutDate(dateStr),
      walletCategory,
      rawDataJson,
      rawHash,
    });
  }

  return mutations;
}

/** Extracts the total page count from the pagination HTML, returns 1 if not found */
function parseTotalPages(html: string): number {
  // Match last page number from pagination links like /riwayat-saldo/index/N
  const matches = [...html.matchAll(/riwayat-saldo\/index\/(\d+)/g)];
  if (!matches.length) return 1;
  const pages = matches.map((m) => parseInt(m[1], 10)).filter((n) => !isNaN(n));
  return pages.length ? Math.max(...pages) : 1;
}

// ── Gateway class ─────────────────────────────────────────────────────────────

export class RealOrkutGateway implements IOrkutGateway {
  /**
   * Fetches QRIS payment mutations from orderkuota.com/akun/riwayat-saldo
   * by scraping the HTML using the session cookies stored on the account.
   *
   * Returns empty array if no cookies are configured.
   */
  async fetchMutations(account: QrisAccount): Promise<RawMutation[]> {
    const encryptedCookieSource = account.webCookiesEncrypted ?? account.cookiesEncrypted;
    if (!encryptedCookieSource) return [];

    let cookies: string;
    try {
      cookies = decrypt(encryptedCookieSource);
    } catch {
      logger.warn({ accountCode: account.code }, 'orkut-gateway: failed to decrypt cookies');
      return [];
    }

    const headers = {
      Cookie:            cookies,
      'User-Agent':      account.webUserAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept:            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
      Referer:           ORKUT_BASE + '/',
    };

    // Fetch page 1 to determine total pages
    let firstHtml: string;
    try {
      const res = await fetch(`${ORKUT_BASE}${MUTATION_PATH}`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        logger.warn({ accountCode: account.code, status: res.status }, 'orkut-gateway: HTTP error');
        return [];
      }
      firstHtml = await res.text();
    } catch (err) {
      logger.error({ err, accountCode: account.code }, 'orkut-gateway: fetch failed');
      return [];
    }

    const totalPages = parseTotalPages(firstHtml);
    const allMutations: RawMutation[] = parseOrkutHtml(firstHtml);

    // Fetch remaining pages (cap at 10 to avoid hammering the server)
    const maxPages = Math.min(totalPages, 10);
    for (let page = 2; page <= maxPages; page++) {
      try {
        const res = await fetch(`${ORKUT_BASE}${MUTATION_PATH}/index/${page}`, {
          headers,
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) break;
        const html = await res.text();
        allMutations.push(...parseOrkutHtml(html));
      } catch {
        break; // stop on error, return what we have
      }
    }

    logger.debug(
      { accountCode: account.code, pages: maxPages, total: allMutations.length },
      'orkut-gateway: fetched mutations',
    );

    return allMutations;
  }

  async generateQr(
    _account: QrisAccount,
    _finalAmount: number,
    _note: string,
  ): Promise<QrGenerationResult> {
    throw new Error('RealOrkutGateway.generateQr is not yet implemented.');
  }

  async recheckTransaction(_qrId: string, _account: QrisAccount): Promise<RecheckResult> {
    throw new Error('RealOrkutGateway.recheckTransaction is not yet implemented.');
  }
}

export const realGateway = new RealOrkutGateway();
