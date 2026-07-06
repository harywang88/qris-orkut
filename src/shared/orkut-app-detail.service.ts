import type { PresentedQrisMutation } from './orkut-web-report.service';

export interface AppQrisDetailEnrichment {
  amount: number | null;
  amountNett: number | null;
  brandName: string | null;
  cpan: string | null;
  displayTime: string | null;
  feeText: string | null;
  mid: string | null;
  mpan: string | null;
  nmid: string | null;
  raw: Record<string, unknown>;
  rawId: string;
  rrn: string | null;
  senderName: string | null;
  statusCode: 'IN' | 'OUT';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hasSeconds(value: string | null | undefined): boolean {
  return typeof value === 'string' && /\d{2}:\d{2}:\d{2}$/.test(value.trim());
}

export function readPresentedMutationRawId(rawDataJson: string): string {
  try {
    const parsed = JSON.parse(rawDataJson) as Record<string, unknown>;
    const value = parsed.id;
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
  } catch {
    // ignore malformed JSON
  }
  return '';
}

function buildBankEwallet(row: PresentedQrisMutation, detail: AppQrisDetailEnrichment): string {
  const senderNetwork = readString(detail.senderName).split('/')[0]?.trim() || '';
  const currentParts = readString(row.bankEwallet)
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  const uniqueParts = [...new Set([
    readString(detail.brandName),
    senderNetwork,
    ...currentParts,
  ].filter(Boolean))];

  return uniqueParts.join(' / ') || row.bankEwallet;
}

export function enrichPresentedQrisMutationsWithAppDetails(
  rows: PresentedQrisMutation[],
  details: AppQrisDetailEnrichment[],
): PresentedQrisMutation[] {
  if (!rows.length || !details.length) return rows;

  const detailMap = new Map(details.map((detail) => [detail.rawId, detail] as const));

  return rows.map((row) => {
    const rawId = readPresentedMutationRawId(row.rawDataJson);
    if (!rawId) return row;

    const detail = detailMap.get(rawId);
    if (!detail) return row;

    return {
      ...row,
      bankEwallet: buildBankEwallet(row, detail),
      brandName: detail.brandName || row.brandName,
      displayTime:
        detail.displayTime && (!hasSeconds(row.displayTime) || hasSeconds(detail.displayTime))
          ? detail.displayTime
          : row.displayTime,
      rrn: detail.rrn || row.rrn,
      senderName: detail.senderName || row.senderName,
      statusCode: detail.statusCode || row.statusCode,
      statusText: detail.statusCode === 'OUT' ? 'Dana Keluar' : 'Dana Masuk',
    };
  });
}

export function mergeRawMutationWithAppDetail(
  rawDataJson: string,
  detail: AppQrisDetailEnrichment,
): string {
  const raw = (() => {
    try {
      const parsed = JSON.parse(rawDataJson) as Record<string, unknown>;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  })();

  const merged: Record<string, unknown> = {
    ...raw,
    amount_nett: detail.amountNett ?? raw.amount_nett,
    brand_name: detail.brandName ?? raw.brand_name,
    buyer_ref: detail.senderName ?? raw.buyer_ref,
    cpan: detail.cpan ?? raw.cpan,
    date: detail.displayTime ?? raw.date,
    fee: detail.feeText ?? raw.fee,
    id: raw.id ?? detail.rawId,
    issuer_ref: detail.rrn ?? raw.issuer_ref,
    mid: detail.mid ?? raw.mid,
    mpan: detail.mpan ?? raw.mpan,
    nmid: detail.nmid ?? raw.nmid,
    rrn: detail.rrn ?? raw.rrn,
  };

  return JSON.stringify(merged);
}
