import crypto from 'crypto';
import type { QrisAccount } from '@prisma/client';
import { Headers, ProxyAgent, fetch as undiciFetch } from 'undici';
import { decrypt } from '../../core/encryption';
import { logger } from '../../config/logger';
import type {
  IOrkutGateway,
  QrGenerationResult,
  RecheckResult,
  RawMutation,
} from './gateway.interface';

// ── Constants ──────────────────────────────────────────────────────────────────

const APP_BASE            = 'https://app.orderkuota.com';
const APP_VERSION_CODE    = '260204';
const APP_VERSION_NAME    = '26.02.04';
// Match the real Android device profile used when this OrderKuota session was captured.
const PHONE_MODEL         = process.env.ORKUT_PHONE_MODEL?.trim() || 'SM-N976N';
const PHONE_ANDROID_VER   = process.env.ORKUT_ANDROID_VERSION?.trim() || '7.1.2';
const UI_MODE             = 'light';
const MAX_PAGES           = 10;
export const APP_QRIS_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const APP_PROXY_URL       = process.env.ORKUT_PROXY_URL?.trim() || '';
const APP_PROXY_AGENT     = APP_PROXY_URL ? new ProxyAgent(APP_PROXY_URL) : undefined;
// Egress khusus nobubank (finalisasi PIN Kirim Uang). Kosong = langsung dari IP VPS.
// Isi dengan residential/ID proxy HANYA jika nobubank memblokir IP VPS.
const NOBU_PROXY_URL      = process.env.NOBU_PROXY_URL?.trim() || '';
const NOBU_PROXY_AGENT    = NOBU_PROXY_URL ? new ProxyAgent(NOBU_PROXY_URL) : undefined;

/**
 * Fallback mapping nama bank tampilan → kode SWIFT/BIC yang digunakan API OrderKuota.
 * Kode ini didapat dari response `requests[madera_transfer][action]=get`.
 * Mapping dinamis (dari API) akan diutamakan jika tersedia.
 */
const BANK_SWIFT_MAP: Record<string, string> = {
  // ─── Bank Umum ───
  'BCA':                  'CENAIDJA',
  'BRI':                  'BRINIDJA',
  'BNI':                  'BNINIDJA',
  'Mandiri':              'BMRIIDJA',
  'CIMB Niaga':           'BNIAIDJA',
  'Danamon':              'BDINIDJA',
  'Permata':              'BBBAIDJA',
  'BTN':                  'BTANIDJA',
  'Panin':                'PINBIDJA',
  'Maybank':              'IBBKIDJA',
  'OCBC NISP':            'NISPIDJA',
  'BTPN':                 'PUBAIDJ1',
  'Mega':                 'MEGAIDJA',
  'Bukopin':              'BBUKIDJA',
  'Sinarmas':             'SBJKIDJA',
  'Bank Sinarmas':        'SBJKIDJA',
  'MNC Bank':             'BUMIIDJA',
  'Artha Graha':          'MCORIDJA',
  'Jago':                 'JAGBIDJA',
  'Allo Bank':            'ALOBIDJA',
  'SeaBank':              'SSPIIDJA',
  'Bank Neo Commerce':    'YUDBIDJ1',
  'Bank Raya':            'AGTBIDJA',
  'Bank Amar':            'LOMAIDJ1',
  'Bank Sahabat Sampoerna': 'SAHMIDJA',
  'Bank Index':           'BIDXIDJA',
  'Bank Ganesha':         'GNESIDJA',
  'Bank Ina Perdana':     'IAPTIDJA',
  'Bank Maspion':         'MASDIDJ1',
  'Bank Mestika':         'MEDHIDS1',
  'Bank Mitraniaga':      'MGABIDJ1',
  'Bank OCBC':            'NISPIDJA',
  'Bank Prima Master':    'PMASIDJ1',
  'Bank Shinhan':         'MEEKIDJ1',
  'Bank SBI Indonesia':   'IDMOIDJ1',
  'Bank UOB':             'BBIJIDJA',
  'Jenius':               'PUBAIDJ1',
  // ─── Bank Pembangunan Daerah ───
  'BJB':                  'PDJBIDJA',
  'Bank Jateng':          'PDJGIDJ1',
  'Bank Jatim':           'PDJTIDJ1',
  'Bank DIY':             'PDYKIDJ1',
  'Bank Sumsel Babel':    'BSSPIDSP',
  'Bank Sumut':           'PDSUIDJ1',
  'Bank Sumbar':          'PDSBIDJ1',
  'Bank Aceh':            'PDACIDJ1',
  'Bank Riau Kepri':      'PDRIIDJA',
  'Bank Lampung':         'PDLPIDJ1',
  'Bank Bengkulu':        'PDBKIDJ1',
  'Bank Kaltim':          'PDKTIDJ1',
  'Bank Kalbar':          'PDKBIDJ1',
  'Bank Kalteng':         'PDKGIDJ1',
  'Bank Kalsel':          'PDKSIDJ1',
  'Bank Sulteng':         'PDWGIDJ1',
  'Bank Sulut':           'PDWUIDJ1',
  'Bank Sulsel':          'PDWSIDJA',
  'Bank Sultra':          'PDWRIDJ1',
  'Bank Maluku':          'PDMLIDJ1',
  'Bank Papua':           'PDIJIDJ1',
  'Bank NTB':             'PDNBIDJ1',
  'Bank Bali':            'ABALIDBS',
  'Bank BPD DIY':         'PDYKIDJ1',
  'BPD Sultengg':         'PDWGIDJ1',
};

/** Cache daftar bank dari API per account code. */
const bankListCache = new Map<string, { banks: Record<string, { name: string; fee: number; status: string }>; fetchedAt: number }>();
const BANK_LIST_CACHE_TTL_MS = 30 * 60 * 1000; // 30 menit

/**
 * Resolve nama bank ke kode SWIFT/BIC yang dibutuhkan API OrderKuota.
 * Prioritas: cache dinamis dari API → fallback hardcoded → nama asli.
 */
function resolveBankCode(bankName: string, accountCode?: string): string {
  // 0. If already a SWIFT/BIC code (all uppercase alphanumeric, 6-15 chars), return as-is
  if (/^[A-Z0-9]{6,15}$/.test(bankName) && bankName === bankName.toUpperCase()) {
    return bankName;
  }

  // 1. Cek cache dinamis (dari fetchMaderaBankList)
  if (accountCode) {
    const cached = bankListCache.get(accountCode);
    if (cached && Date.now() - cached.fetchedAt < BANK_LIST_CACHE_TTL_MS) {
      const inputLower = bankName.toLowerCase();
      const inputStripped = inputLower.replace(/^bank\s+/i, '');

      // Pass 1: exact match (case-insensitive)
      for (const [swiftCode, info] of Object.entries(cached.banks)) {
        if (info.name.toLowerCase() === inputLower) return swiftCode;
      }
      // Pass 2: strip "Bank " prefix dan compare
      for (const [swiftCode, info] of Object.entries(cached.banks)) {
        const apiStripped = info.name.toLowerCase().replace(/^bank\s+/i, '');
        if (apiStripped === inputStripped) return swiftCode;
      }
      // Pass 3: includes match — prefer shortest API name (paling spesifik)
      let bestMatch: string | null = null;
      let bestLen = Infinity;
      for (const [swiftCode, info] of Object.entries(cached.banks)) {
        const apiStripped = info.name.toLowerCase().replace(/^bank\s+/i, '');
        if ((apiStripped.includes(inputStripped) || inputStripped.includes(apiStripped))
          && info.name.length < bestLen) {
          bestMatch = swiftCode;
          bestLen = info.name.length;
        }
      }
      if (bestMatch) return bestMatch;
    }
  }

  // 2. Fallback ke hardcoded SWIFT map
  if (BANK_SWIFT_MAP[bankName]) return BANK_SWIFT_MAP[bankName];
  const lower = bankName.toLowerCase();
  for (const [key, code] of Object.entries(BANK_SWIFT_MAP)) {
    if (key.toLowerCase() === lower) return code;
  }

  // 3. Fallback: return nama asli
  return bankName;
}

function resolveBankRouting(bankName: string, accountCode?: string): { code: string; name: string } {
  const code = resolveBankCode(bankName, accountCode);

  if (accountCode) {
    const cached = bankListCache.get(accountCode);
    if (cached && Date.now() - cached.fetchedAt < BANK_LIST_CACHE_TTL_MS) {
      const byCode = cached.banks[code];
      if (byCode) {
        return {
          code,
          name: byCode.name || bankName,
        };
      }
    }
  }

  return { code, name: bankName };
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AppAccountBalance {
  mainBalance: number | null;
  qrisBalance: number | null;
}

export interface AppMutationResult {
  mutations: RawMutation[];
  balance: AppAccountBalance;
}

export interface AppQrisFetchOptions {
  knownRawHashes?: Iterable<string>;
  maxPages?: number;
  fromTime?: Date | null;
  stopOnKnown?: boolean;
}

export interface AppBalanceHistoryResult {
  mutations: RawMutation[];   // walletCategory = 'utama'
  mainBalance: number | null;
}

export interface AppQrisMerchantTerms {
  qrisData: string;
  min: number;
  max: number;
  expired: number;  // seconds
}

export interface AppQrisWithdrawTerms {
  mainBalance: number | null;
  qrisBalance: number | null;
  isEnabled: boolean;
  max: number;
  message: string | null;
  min: number;
  raw: Record<string, unknown>;
}

export interface AppQrisWithdrawResult {
  message: string;
  raw: Record<string, unknown>;
  success: boolean;
}

export interface AppMaderaTopupResult {
  detailsId: string | null;
  message: string;
  raw: Record<string, unknown>;
  success: boolean;
}

export interface AppBankInquiryResult {
  accountName: string | null;
  accountNumber: string | null;
  bankCode: string | null;
  bankName: string | null;
  fee: number | null;
  message: string | null;
  raw: Record<string, unknown>;
  sessionId: string | null;
  sourceWallet: 'utama' | 'madera';
  success: boolean;
}

export interface AppBankTransferResult {
  accountName: string | null;
  accountNumber: string | null;
  bankCode: string | null;
  bankName: string | null;
  fee: number | null;
  message: string | null;
  raw: Record<string, unknown>;
  referenceNo: string | null;
  redirectUrl: string | null;
  sourceWallet: 'utama' | 'madera';
  status: 'done' | 'processing' | 'failed';
  success: boolean;
}

export interface AppMaderaTransferOverview {
  accountBalance: number | null;
  banks: Record<string, { fee: number; name: string; status: string }>;
  fee: number | null;
  max: number | null;
  message: string | null;
  min: number | null;
  raw: Record<string, unknown>;
}

export interface AppQrisMutationDetail {
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

export class AppOrkutRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(message = 'OrderKuota QRIS sedang rate limited', retryAfterMs = APP_QRIS_RATE_LIMIT_COOLDOWN_MS) {
    super(message);
    this.name = 'AppOrkutRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Parse sessionTokenEncrypted yang bisa dalam 2 format:
 *   - "accountId:tokenSecret"                  (lama)
 *   - "username:accountId:tokenSecret"         (baru, dengan username)
 */
function parseSessionToken(raw: string): {
  authUsername: string;
  accountId: string;
  tokenSecret: string;
  authToken: string;   // "accountId:tokenSecret" — persis seperti yang dikirim ke API
} {
  const parts = raw.split(':');
  if (parts.length === 3) {
    // format baru: username:accountId:tokenSecret
    const [authUsername, accountId, tokenSecret] = parts;
    return { authUsername, accountId, tokenSecret, authToken: `${accountId}:${tokenSecret}` };
  }
  if (parts.length === 2) {
    // format lama: accountId:tokenSecret
    const [accountId, tokenSecret] = parts;
    return { authUsername: accountId, accountId, tokenSecret, authToken: raw };
  }
  throw new Error(`Invalid sessionToken format (expected 2 or 3 parts separated by ":", got ${parts.length})`);
}

/**
 * Legacy header seed. signedAppFetch replaces it with the canonical Android
 * signature after the complete request body has been assembled.
 */
function buildSignature(timestamp: string, tokenSecret: string): string {
  return crypto.createHmac('sha512', tokenSecret).update(timestamp).digest('hex');
}

function buildOfficialSignature(body: URLSearchParams): { signature: string; timestamp: string } | null {
  const timestamp = body.get('request_time')?.trim() || '';
  const authToken = body.get('auth_token')?.trim() || '';
  if (!timestamp || !authToken || timestamp.length !== 13) return null;

  const canonicalValues = Array.from(body.values())
    .map((value) => `${value.length}${value}`)
    .sort()
    .join('');
  const payload = `${canonicalValues.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}:${authToken}`;
  const digest = crypto
    .createHash('sha512')
    .update(`000${timestamp}`, 'utf8')
    .update(payload, 'utf8')
    .digest('hex');

  return {
    signature: `${digest.slice(-10)}${digest.slice(10, -10)}${digest.slice(0, 10)}`,
    timestamp,
  };
}

async function signedAppFetch(input: string | URL, init: RequestInit = {}, useNobuEgress = false) {
  const headers = new Headers(init.headers as ConstructorParameters<typeof Headers>[0]);
  if (init.body instanceof URLSearchParams) {
    const signed = buildOfficialSignature(init.body);
    if (signed) {
      headers.set('Signature', signed.signature);
      headers.set('Timestamp', signed.timestamp);
    }
  }

  return undiciFetch(input, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    headers,
    // OrderKuota lewat bridge (APP_PROXY_AGENT); nobubank lewat NOBU_PROXY_AGENT
    // (undefined = langsung dari IP VPS Indonesia).
    dispatcher: useNobuEgress ? NOBU_PROXY_AGENT : APP_PROXY_AGENT,
  });
}

function parseAmount(val: unknown): number {
  if (typeof val === 'number') return Math.trunc(val);
  if (typeof val === 'string') {
    const cleaned = val.replace(/[.,\s]/g, '').trim();
    return parseInt(cleaned, 10) || 0;
  }
  return 0;
}

function readString(val: unknown): string {
  return typeof val === 'string' ? val.trim() : '';
}

function parseOptionalAmount(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string' && val.trim() === '') return null;
  return parseAmount(val);
}

function asRecord(val: unknown): Record<string, unknown> | undefined {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? val as Record<string, unknown>
    : undefined;
}

function asRecordArray(val: unknown): Record<string, unknown>[] {
  if (!Array.isArray(val)) return [];
  return val.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
}

function parseBoolean(val: unknown): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') {
    const normalized = val.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  return false;
}

type AppSendMoneyDetail = {
  accountName: string | null;
  accountNumber: string | null;
  bankCode: string | null;
  bankName: string | null;
  branchCity: string | null;
  fee: number | null;
  feeUser: number | null;
  id: string | null;
  message: string | null;
  note: string | null;
  raw: Record<string, unknown>;
  referenceNo: string | null;
  status: string | null;
};

function parseSendMoneyStatus(value: unknown): 'done' | 'processing' | 'failed' {
  const raw = readString(value).toUpperCase();
  if (raw === 'DONE' || raw === 'SUKSES' || raw === 'SUCCESS') return 'done';
  if (raw === 'PENDING' || raw === 'PROSES' || raw === 'PROCESSING' || raw === 'WAITING') return 'processing';
  return 'failed';
}

function parseSendMoneyDetail(raw: unknown, fallbackMessage?: string | null): AppSendMoneyDetail | null {
  const data = asRecord(raw);
  if (!data) return null;

  return {
    accountName: readString(data.account_name) || null,
    accountNumber: readString(data.account_number) || null,
    bankCode: readString(data.bank_code) || null,
    bankName: readString(data.bank_name) || null,
    branchCity: readString(data.branch_city) || null,
    fee: parseOptionalAmount(data.fee),
    feeUser: parseOptionalAmount(data.fee_user),
    id: readString(data.id) || null,
    message: readString(data.message) || fallbackMessage || null,
    note: readString(data.keterangan) || null,
    raw: data,
    referenceNo: readString(data.receipt) || readString(data.id) || null,
    status: readString(data.status) || null,
  };
}

function readApiMessage(json: Record<string, unknown>): string {
  return readString(json.message) || readString(json.msg) || readString(json.error);
}

function normalizeBankInquiryMessage(message: string, sourceWallet: 'utama' | 'madera'): string {
  const normalized = message.trim();
  if (!normalized) {
    return sourceWallet === 'madera'
      ? 'Inquiry rekening dari Saldo Madera gagal diproses.'
      : 'Inquiry rekening gagal diproses.';
  }

  const lower = normalized.toLowerCase();
  if (lower.includes('minimal nominal')) {
    return sourceWallet === 'madera'
      ? 'Minimal nominal cek rekening dari Saldo Madera Rp 10.000.'
      : 'Minimal nominal cek rekening belum terpenuhi.';
  }
  if (lower.includes('invalid routing')) {
    return 'Bank atau nomor rekening tidak valid. Pilih bank yang tepat lalu cek lagi.';
  }
  if (lower.includes('account inquiry') || lower.includes('nomor rekening')) {
    return 'Nama pemilik rekening belum bisa dibaca. Periksa bank dan nomor rekening lalu coba lagi.';
  }

  return normalized;
}

function isQrisRateLimited(status: number, json: Record<string, unknown>): boolean {
  if (status === 469) return true;
  const message = readApiMessage(json).toLowerCase();
  return message.includes('terlalu sering membuka menu qris merchant')
    || message.includes('coba kembali 5 menit')
    || message.includes('rate limit');
}

function parseDate(val: unknown): Date {
  if (!val) return new Date();
  const str = String(val);
  // Format "DD/MM/YYYY HH:mm" or "DD/MM/YYYY HH:mm:ss" → ISO (WIB UTC+7)
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, dd, mm, yyyy, HH, MM, SS = '00'] = m;
    return new Date(`${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}+07:00`);
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? new Date() : d;
}

function formatAppDateTime(value: Date): string {
  const shifted = new Date(value.getTime() + (7 * 60 * 60 * 1000));
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = shifted.getUTCFullYear();
  const HH = String(shifted.getUTCHours()).padStart(2, '0');
  const MM = String(shifted.getUTCMinutes()).padStart(2, '0');
  const SS = String(shifted.getUTCSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${HH}:${MM}:${SS}`;
}

function normalizeAppStatus(value: unknown): 'IN' | 'OUT' {
  const raw = readString(value).toUpperCase();
  if (raw === 'DEBIT' || raw === 'OUT') return 'OUT';
  return 'IN';
}

function classifyBalanceHistoryWallet(description: string): 'qris' | 'utama' | 'madera' {
  const text = description.toLowerCase();

  if (text.includes('pindah saldo ke madera')) {
    return 'utama';
  }

  if (
    text.includes('madera')
    || text.includes('topup madera')
    || text.includes('bi fast out')
    || text.includes('bifast out')
    || text.includes('transfer bi fast')
    || text.includes('biaya transfer bi fast')
  ) {
    return 'madera';
  }

  if (
    text.includes('pencairan qris')
    || text.includes('pencairan saldo qris')
    || text.includes('withdraw qris')
    || text.includes('biaya percepatan pencairan qris')
    || text.includes('tarik saldo qris')
    || text.includes('pindah saldo ke madera')
  ) {
    return 'utama';
  }

  return 'utama';
}

type AppRequestContext = {
  appRegId: string;
  parsed: ReturnType<typeof parseSessionToken>;
  phoneUuid: string;
};

function resolveAppRequestContext(
  account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>,
): AppRequestContext | null {
  if (!account.sessionTokenEncrypted) return null;

  try {
    const parsed = parseSessionToken(decrypt(account.sessionTokenEncrypted));
    let appRegId = parsed.accountId;
    if (account.cookiesEncrypted) {
      try {
        appRegId = decrypt(account.cookiesEncrypted);
      } catch {
        // fallback to parsed accountId
      }
    }

    return {
      parsed,
      appRegId,
      phoneUuid: account.deviceId ?? parsed.accountId,
    };
  } catch (err) {
    logger.warn({ accountCode: account.code, err }, 'app-orkut: failed to resolve request context');
    return null;
  }
}

/**
 * Parse satu entry dari qris_history.results atau balance_history.results.
 * walletCat: 'qris' untuk mutasi QRIS, 'utama' untuk balance history.
 */
function parseMutationEntry(raw: Record<string, unknown>, walletCat: 'qris' | 'utama' | 'madera' = 'qris'): RawMutation | null {
  // ── Amount ────────────────────────────────────────────────────────────────
  const kredit      = parseAmount(raw.kredit ?? raw.credit ?? 0);
  const debet       = parseAmount(raw.debet ?? raw.debit ?? 0);
  const isCredit    = kredit > 0;
  const amount      = isCredit ? kredit : debet;
  if (amount === 0) return null;

  // ── Balance ───────────────────────────────────────────────────────────────
  const balanceAfter = parseAmount(
    raw.saldo ?? raw.saldo_akhir ?? raw.balance_after ?? raw.saldo_sekarang ?? 0,
  );
  const balanceBefore = isCredit
    ? balanceAfter - kredit + debet
    : balanceAfter + debet - kredit;

  // ── Metadata ──────────────────────────────────────────────────────────────
  const dateStr     = String(raw.tanggal ?? raw.date ?? raw.created_at ?? raw.waktu ?? '');
  const description = String(raw.keterangan ?? raw.description ?? raw.note ?? raw.ket ?? '');
  const resolvedWalletCat =
    walletCat === 'utama'
      ? classifyBalanceHistoryWallet(description)
      : walletCat;
  const brandValue  = raw.brand && typeof raw.brand === 'object'
    ? String((raw.brand as Record<string, unknown>).name ?? '')
    : '';
  const issuerFallback =
    raw.bank ??
    raw.bank_name ??
    raw.issuer ??
    raw.bank_ewallet ??
    raw.pengirim ??
    '';
  const issuerName = String(brandValue || issuerFallback);
  const rrn         = raw.rrn
    ? String(raw.rrn)
    : raw.ref
      ? String(raw.ref)
      : raw.reference
        ? String(raw.reference)
        : raw.reference_no
          ? String(raw.reference_no)
          : raw.no_referensi
            ? String(raw.no_referensi)
            : undefined;

  // QRIS pencairan (uang KELUAR): app-api OrderKuota menaruh nominal di field `kredit`
  // (isCredit=true) walau saldo QRIS TURUN → ter-catat 'credit'. Web report mencatatnya
  // 'debit'. Samakan ke 'debit' (+ balanceBefore benar) supaya TER-DEDUP dgn report dan
  // tak dobel di Mutasi QRIS (type ikut ke dalam hash dedup).
  let outType: 'credit' | 'debit' = isCredit ? 'credit' : 'debit';
  let outBalanceBefore = balanceBefore;
  if (resolvedWalletCat === 'qris' && isCredit) {
    const pTxt = (description + ' ' + issuerName).toLowerCase();
    if (pTxt.includes('pencairan') || pTxt.includes('withdraw qris') || pTxt.includes('tarik saldo qris')) {
      outType = 'debit';
      outBalanceBefore = balanceAfter + amount; // OUT: saldo sebelum = saldo sesudah + nominal
    }
  }

  // ── Dedup hash ────────────────────────────────────────────────────────────
  const hashSource  = `app-orkut:${resolvedWalletCat}:${description}:${dateStr}:${amount}:${balanceAfter}`;
  const rawHash     = crypto.createHash('sha256').update(hashSource).digest('hex');

  return {
    amount,
    type:            outType,
    balanceBefore:   outBalanceBefore,
    balanceAfter,
    issuerName:      issuerName || undefined,
    rrn,
    walletCategory:  resolvedWalletCat,
    transactionTime: parseDate(dateStr),
    rawDataJson:     JSON.stringify(raw),
    rawHash,
  };
}

// ── Gateway ────────────────────────────────────────────────────────────────────

export class AppOrkutGateway implements IOrkutGateway {
  /**
   * Ambil semua mutasi QRIS dari app.orderkuota.com/api/v2/qris/mutasi/{accountId}.
   * Otomatis pagination sampai MAX_PAGES.
   */
  async fetchMutations(account: QrisAccount): Promise<RawMutation[]> {
    const result = await this.fetchMutationsAndBalance(account);
    return result.mutations;
  }

  async fetchAccountSummary(
    account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>,
  ): Promise<AppAccountBalance> {
    const ctx = resolveAppRequestContext(account);
    if (!ctx) {
      return { mainBalance: null, qrisBalance: null };
    }

    const { parsed, appRegId, phoneUuid } = ctx;
    const timestamp = String(Date.now());
    const signature = buildSignature(timestamp, parsed.tokenSecret);
    const body = new URLSearchParams({
      request_time: timestamp,
      app_reg_id: appRegId,
      phone_android_version: PHONE_ANDROID_VER,
      app_version_code: APP_VERSION_CODE,
      phone_uuid: phoneUuid,
      auth_username: parsed.authUsername,
      auth_token: parsed.authToken,
      app_version_name: APP_VERSION_NAME,
      ui_mode: UI_MODE,
      'requests[0]': 'account',
      phone_model: PHONE_MODEL,
    });

    try {
      const res = await signedAppFetch(`${APP_BASE}/api/v2/get`, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip',
          Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded',
          Host: 'app.orderkuota.com',
          Signature: signature,
          Timestamp: timestamp,
          'User-Agent': 'okhttp/5.3.2',
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });

      const text = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        logger.warn(
          { accountCode: account.code, preview: text.slice(0, 200) },
          'app-orkut account-summary: non-JSON response',
        );
        return { mainBalance: null, qrisBalance: null };
      }

      if (!res.ok || json.success === false) {
        if (isQrisRateLimited(res.status, json)) {
          throw new AppOrkutRateLimitError(
            readApiMessage(json) || 'OrderKuota menahan akses account summary sementara',
          );
        }
        logger.warn(
          { accountCode: account.code, status: res.status, json },
          'app-orkut account-summary: error response',
        );
        return { mainBalance: null, qrisBalance: null };
      }

      const acctWrapper = json.account as Record<string, unknown> | undefined;
      const acctData = (acctWrapper?.results ?? acctWrapper) as Record<string, unknown> | undefined;
      return {
        mainBalance: acctData ? parseOptionalAmount(acctData.balance ?? acctData.main_balance ?? null) : null,
        qrisBalance: acctData ? parseOptionalAmount(acctData.qris_balance ?? null) : null,
      };
    } catch (err) {
      if (err instanceof AppOrkutRateLimitError) {
        throw err;
      }
      logger.error({ err, accountCode: account.code }, 'app-orkut: fetchAccountSummary error');
      return { mainBalance: null, qrisBalance: null };
    }
  }

  /**
   * Extended fetch — juga kembalikan saldo akun dari response API.
   * Dipanggil oleh orkut-fetch.loop untuk update balance snapshot.
   */
  async fetchMutationsAndBalance(account: QrisAccount, options: AppQrisFetchOptions = {}): Promise<AppMutationResult> {
    const empty: AppMutationResult = { mutations: [], balance: { mainBalance: null, qrisBalance: null } };
    const hasIncrementalHints =
      !!options.fromTime
      || options.maxPages !== undefined
      || options.stopOnKnown !== undefined
      || (options.knownRawHashes !== undefined && Array.from(options.knownRawHashes).length > 0);

    if (hasIncrementalHints) {
      return this.fetchIncrementalMutationsAndBalance(account, options);
    }

    if (!account.sessionTokenEncrypted) return empty;

    // ── Decrypt credentials ─────────────────────────────────────────────────
    let parsed: ReturnType<typeof parseSessionToken>;
    try {
      const rawToken = decrypt(account.sessionTokenEncrypted);
      parsed = parseSessionToken(rawToken);
    } catch (err) {
      logger.warn({ accountCode: account.code, err }, 'app-orkut: failed to decrypt/parse session token');
      return empty;
    }

    let appRegId = parsed.accountId; // fallback
    if (account.cookiesEncrypted) {
      try {
        appRegId = decrypt(account.cookiesEncrypted);
      } catch {
        // use fallback
      }
    }

    const phoneUuid = account.deviceId ?? parsed.accountId;
    const url       = `${APP_BASE}/api/v2/qris/mutasi/${parsed.accountId}`;

    // ── Fetch page 1 ────────────────────────────────────────────────────────
    const firstResult = await this._fetchPage(url, 1, parsed, appRegId, phoneUuid, account.code);
    if (!firstResult) return empty;

    const { pageData: firstPage, balance } = firstResult;
    const allMutations: RawMutation[] = this._parsePage(firstPage, account.code);

    const totalPages = Math.min(
      typeof firstPage.pages === 'number' ? firstPage.pages : 1,
      MAX_PAGES,
    );

    // ── Fetch remaining pages ───────────────────────────────────────────────
    for (let page = 2; page <= totalPages; page++) {
      const r = await this._fetchPage(url, page, parsed, appRegId, phoneUuid, account.code);
      if (!r) break;
      allMutations.push(...this._parsePage(r.pageData, account.code));
    }

    logger.debug(
      { accountCode: account.code, pages: totalPages, total: allMutations.length },
      'app-orkut: fetched mutations',
    );

    return { mutations: allMutations, balance };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  async fetchIncrementalMutationsAndBalance(
    account: QrisAccount,
    options: AppQrisFetchOptions = {},
  ): Promise<AppMutationResult> {
    const empty: AppMutationResult = { mutations: [], balance: { mainBalance: null, qrisBalance: null } };
    const context = resolveAppRequestContext(account);
    if (!context) return empty;

    const knownRawHashes = new Set(options.knownRawHashes ?? []);
    const maxPages = Math.max(1, Math.min(options.maxPages ?? 3, MAX_PAGES));
    const stopOnKnown = options.stopOnKnown !== false;
    const fromDate = options.fromTime ? formatAppDateTime(options.fromTime) : '';
    const url = `${APP_BASE}/api/v2/qris/mutasi/${context.parsed.accountId}`;

    const firstResult = await this._fetchPage(
      url,
      1,
      context.parsed,
      context.appRegId,
      context.phoneUuid,
      account.code,
      { fromDate },
    );
    if (!firstResult) return empty;

    const { pageData: firstPage, balance } = firstResult;
    const allMutations: RawMutation[] = [];
    let encounteredKnownHash = this._appendFreshMutations(
      allMutations,
      this._parsePage(firstPage, account.code),
      knownRawHashes,
      stopOnKnown,
    );

    const totalPages = Math.min(
      typeof firstPage.pages === 'number' ? firstPage.pages : 1,
      maxPages,
    );

    for (let page = 2; page <= totalPages; page++) {
      if (encounteredKnownHash && stopOnKnown) break;

      const result = await this._fetchPage(
        url,
        page,
        context.parsed,
        context.appRegId,
        context.phoneUuid,
        account.code,
        { fromDate },
      );
      if (!result) break;

      encounteredKnownHash = this._appendFreshMutations(
        allMutations,
        this._parsePage(result.pageData, account.code),
        knownRawHashes,
        stopOnKnown,
      ) || encounteredKnownHash;
    }

    logger.debug(
      {
        accountCode: account.code,
        pages: totalPages,
        total: allMutations.length,
        knownHashes: knownRawHashes.size,
        stopOnKnown,
        fromDate: fromDate || null,
      },
      'app-orkut: fetched incremental mutations',
    );

    return { mutations: allMutations, balance };
  }

  private async _fetchPage(
    url: string,
    page: number,
    parsed: ReturnType<typeof parseSessionToken>,
    appRegId: string,
    phoneUuid: string,
    accountCode: string,
    filters: { fromDate?: string; toDate?: string } = {},
  ): Promise<{ pageData: Record<string, unknown>; balance: AppAccountBalance } | null> {
    const timestamp = String(Date.now());
    const signature = buildSignature(timestamp, parsed.tokenSecret);

    const body = new URLSearchParams({
      app_reg_id:                          appRegId,
      phone_uuid:                          phoneUuid,
      phone_model:                         PHONE_MODEL,
      'requests[qris_history][keterangan]': '',
      'requests[qris_history][jumlah]':    '',
      request_time:                        timestamp,
      phone_android_version:               PHONE_ANDROID_VER,
      app_version_code:                    APP_VERSION_CODE,
      auth_username:                       parsed.authUsername,
      'requests[qris_history][page]':      String(page),
      auth_token:                          parsed.authToken,
      app_version_name:                    APP_VERSION_NAME,
      ui_mode:                             UI_MODE,
      'requests[qris_history][dari_tanggal]': filters.fromDate ?? '',
      'requests[0]':                       'account',
      'requests[qris_history][ke_tanggal]': filters.toDate ?? '',
    });

    try {
      const res = await signedAppFetch(url, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip',
          Connection:        'Keep-Alive',
          'Content-Type':    'application/x-www-form-urlencoded',
          Host:              'app.orderkuota.com',
          Signature:         signature,
          Timestamp:         timestamp,
          'User-Agent':      'okhttp/5.3.2',
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });

      const text = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        logger.warn(
          { accountCode, status: res.status, preview: text.slice(0, 300) },
          'app-orkut: non-JSON response — cookies/token mungkin kadaluarsa',
        );
        return null;
      }

      if (!res.ok) {
        if (isQrisRateLimited(res.status, json)) {
          throw new AppOrkutRateLimitError(readApiMessage(json) || 'OrderKuota menahan akses Menu Qris Merchant sementara');
        }
        logger.warn({ accountCode, status: res.status, json }, 'app-orkut: HTTP error');
        return null;
      }

      if (json.success === false) {
        logger.warn({ accountCode, json }, 'app-orkut: API success=false — token mungkin tidak valid');
        return null;
      }

      // ── Balance dari response ───────────────────────────────────────────
      // Response format: account.results.balance & account.results.qris_balance
      const acctWrapper = json.account as Record<string, unknown> | undefined;
      const acctData    = (acctWrapper?.results ?? acctWrapper) as Record<string, unknown> | undefined;
      const balance: AppAccountBalance = {
        mainBalance:  acctData ? (parseAmount(acctData.balance ?? acctData.main_balance ?? null)) || null : null,
        qrisBalance:  acctData ? (parseAmount(acctData.qris_balance ?? null)) || null : null,
      };

      const historyData = json.qris_history as Record<string, unknown> | undefined;
      return { pageData: historyData ?? {}, balance };
    } catch (err) {
      if (err instanceof AppOrkutRateLimitError) {
        throw err;
      }
      logger.error({ err, accountCode }, 'app-orkut: fetch error');
      return null;
    }
  }

  private _parsePage(
    pageData: Record<string, unknown>,
    accountCode: string,
    walletCat: 'qris' | 'utama' | 'madera' = 'qris',
  ): RawMutation[] {
    const results = pageData.results;
    if (!Array.isArray(results)) return [];

    const mutations: RawMutation[] = [];
    for (const raw of results) {
      if (!raw || typeof raw !== 'object') continue;
      const m = parseMutationEntry(raw as Record<string, unknown>, walletCat);
      if (m) mutations.push(m);
      else logger.debug({ accountCode, raw }, 'app-orkut: skipped zero-amount entry');
    }
    return mutations;
  }

  // ── Balance History (Saldo Utama) — /api/v2/get ──────────────────────────

  /**
   * Ambil riwayat saldo utama dari app.orderkuota.com/api/v2/get
   * dengan requests[0]=balance & requests[balance_history][page]=N
   */
  private _appendFreshMutations(
    target: RawMutation[],
    incoming: RawMutation[],
    knownRawHashes: Set<string>,
    stopOnKnown: boolean,
  ): boolean {
    let encounteredKnownHash = false;

    for (const mutation of incoming) {
      if (knownRawHashes.has(mutation.rawHash)) {
        encounteredKnownHash = true;
        if (stopOnKnown) break;
        continue;
      }

      target.push(mutation);
    }

    return encounteredKnownHash;
  }

  async fetchBalanceHistory(
    account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>,
  ): Promise<AppBalanceHistoryResult> {
    const empty: AppBalanceHistoryResult = { mutations: [], mainBalance: null };
    const ctx = resolveAppRequestContext(account);
    if (!ctx) return empty;
    const { parsed, appRegId, phoneUuid } = ctx;

    // Fetch page 1
    const first = await this._fetchBalancePage(1, parsed, appRegId, phoneUuid, account.code);
    if (!first) return empty;

    const allMutations: RawMutation[] = this._parsePage(first.pageData, account.code, 'utama');
    const mainBalance = first.mainBalance;

    const totalPages = Math.min(
      typeof first.pageData.pages === 'number' ? first.pageData.pages : 1,
      MAX_PAGES,
    );
    for (let page = 2; page <= totalPages; page++) {
      const r = await this._fetchBalancePage(page, parsed, appRegId, phoneUuid, account.code);
      if (!r) break;
      allMutations.push(...this._parsePage(r.pageData, account.code, 'utama'));
    }

    logger.debug(
      { accountCode: account.code, total: allMutations.length, mainBalance },
      'app-orkut: fetched balance history',
    );
    return { mutations: allMutations, mainBalance };
  }

  private async _fetchBalancePage(
    page: number,
    parsed: ReturnType<typeof parseSessionToken>,
    appRegId: string,
    phoneUuid: string,
    accountCode: string,
  ): Promise<{ pageData: Record<string, unknown>; mainBalance: number | null } | null> {
    const timestamp = String(Date.now());
    const signature = buildSignature(timestamp, parsed.tokenSecret);

    const body = new URLSearchParams({
      'requests[balance_history][page]': String(page),
      request_time:                      timestamp,
      app_reg_id:                        appRegId,
      phone_android_version:             PHONE_ANDROID_VER,
      app_version_code:                  APP_VERSION_CODE,
      phone_uuid:                        phoneUuid,
      auth_username:                     parsed.authUsername,
      auth_token:                        parsed.authToken,
      app_version_name:                  APP_VERSION_NAME,
      ui_mode:                           UI_MODE,
      'requests[0]':                     'balance',
      phone_model:                       PHONE_MODEL,
    });

    try {
      const res = await signedAppFetch(`${APP_BASE}/api/v2/get`, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip', Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded',
          Host: 'app.orderkuota.com', Signature: signature, Timestamp: timestamp,
          'User-Agent': 'okhttp/5.3.2',
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });

      const text = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        logger.warn({ accountCode, preview: text.slice(0, 200) }, 'app-orkut balance-hist: non-JSON response');
        return null;
      }

      if (!res.ok || json.success === false) {
        logger.warn({ accountCode, status: res.status }, 'app-orkut balance-hist: error response');
        return null;
      }

      // Extract mainBalance dari balance.results.balance
      const balWrapper = json.balance as Record<string, unknown> | undefined;
      const balData    = (balWrapper?.results ?? balWrapper) as Record<string, unknown> | undefined;
      const mainBalance = balData ? (parseAmount(balData.balance ?? null)) || null : null;

      const historyData = json.balance_history as Record<string, unknown> | undefined;
      return { pageData: historyData ?? {}, mainBalance };
    } catch (err) {
      logger.error({ err, accountCode }, 'app-orkut balance-hist: fetch error');
      return null;
    }
  }

  // ── QRIS Merchant Terms — /api/v2/get ────────────────────────────────────

  /**
   * Ambil template QRIS statis dari OrderKuota.
   * Digunakan sebagai basis untuk generate QR dinamis dengan nominal tertentu.
   */
  async fetchQrisMerchantTerms(account: QrisAccount): Promise<AppQrisMerchantTerms | null> {
    const ctx = resolveAppRequestContext(account);
    if (!ctx) return null;
    const { parsed, appRegId, phoneUuid } = ctx;

    const timestamp = String(Date.now());
    const signature = buildSignature(timestamp, parsed.tokenSecret);

    const body = new URLSearchParams({
      request_time:          timestamp,
      app_reg_id:            appRegId,
      phone_android_version: PHONE_ANDROID_VER,
      app_version_code:      APP_VERSION_CODE,
      phone_uuid:            phoneUuid,
      auth_username:         parsed.authUsername,
      auth_token:            parsed.authToken,
      app_version_name:      APP_VERSION_NAME,
      ui_mode:               UI_MODE,
      'requests[0]':         'qris_merchant_terms',
      phone_model:           PHONE_MODEL,
    });

    try {
      const res = await signedAppFetch(`${APP_BASE}/api/v2/get`, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip', Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded',
          Host: 'app.orderkuota.com', Signature: signature, Timestamp: timestamp,
          'User-Agent': 'okhttp/5.3.2',
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });

      const text = await res.text();
      let json: Record<string, unknown>;
      try { json = JSON.parse(text) as Record<string, unknown>; }
      catch {
        logger.warn({ accountCode: account.code, preview: text.slice(0, 200) }, 'app-orkut qris-terms: non-JSON');
        return null;
      }

      if (!res.ok || json.success === false) {
        if (isQrisRateLimited(res.status, json)) {
          throw new AppOrkutRateLimitError(readApiMessage(json) || 'OrderKuota menahan akses Menu Qris Merchant sementara');
        }
        logger.warn({ accountCode: account.code, status: res.status }, 'app-orkut qris-terms: error response');
        return null;
      }

      const terms   = json.qris_merchant_terms as Record<string, unknown> | undefined;
      const results = (terms?.results ?? terms) as Record<string, unknown> | undefined;
      const qrisData = results?.qris_data as string | undefined;
      if (!qrisData) {
        logger.warn({ accountCode: account.code, results }, 'app-orkut qris-terms: qris_data not found');
        return null;
      }

      return {
        qrisData,
        min:     parseAmount(results?.min ?? 1),
        max:     parseAmount(results?.max ?? 10_000_000),
        expired: typeof results?.expired === 'number' ? results.expired as number : 300,
      };
    } catch (err) {
      if (err instanceof AppOrkutRateLimitError) {
        throw err;
      }
      logger.error({ err, accountCode: account.code }, 'app-orkut: fetchQrisMerchantTerms error');
      return null;
    }
  }

  async fetchQrisWithdrawTerms(
    account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>,
  ): Promise<AppQrisWithdrawTerms | null> {
    const ctx = resolveAppRequestContext(account);
    if (!ctx) return null;
    const { parsed, appRegId, phoneUuid } = ctx;

    const timestamp = String(Date.now());
    const signature = buildSignature(timestamp, parsed.tokenSecret);

    const body = new URLSearchParams({
      request_time:          timestamp,
      app_reg_id:            appRegId,
      phone_android_version: PHONE_ANDROID_VER,
      app_version_code:      APP_VERSION_CODE,
      phone_uuid:            phoneUuid,
      auth_username:         parsed.authUsername,
      auth_token:            parsed.authToken,
      app_version_name:      APP_VERSION_NAME,
      ui_mode:               UI_MODE,
      'requests[0]':         'account',
      'requests[1]':         'qris_withdraw_terms',
      phone_model:           PHONE_MODEL,
    });

    try {
      const res = await signedAppFetch(`${APP_BASE}/api/v2/get`, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip',
          Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded',
          Host: 'app.orderkuota.com',
          Signature: signature,
          Timestamp: timestamp,
          'User-Agent': 'okhttp/5.3.2',
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });

      const text = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        logger.warn({ accountCode: account.code, preview: text.slice(0, 200) }, 'app-orkut qris-withdraw-terms: non-JSON');
        return null;
      }

      if (!res.ok || json.success === false) {
        if (isQrisRateLimited(res.status, json)) {
          throw new AppOrkutRateLimitError(readApiMessage(json) || 'OrderKuota menahan akses tarik QRIS sementara');
        }
        logger.warn({ accountCode: account.code, status: res.status, json }, 'app-orkut qris-withdraw-terms: error response');
        return null;
      }

      const accountWrapper = json.account as Record<string, unknown> | undefined;
      const accountData = (accountWrapper?.results ?? accountWrapper) as Record<string, unknown> | undefined;
      const termsWrapper = json.qris_withdraw_terms as Record<string, unknown> | undefined;
      const termsData = (termsWrapper?.results ?? termsWrapper) as Record<string, unknown> | undefined;

      if (!termsData) {
        logger.warn({ accountCode: account.code, json }, 'app-orkut qris-withdraw-terms: results not found');
        return null;
      }

      return {
        mainBalance: parseOptionalAmount(accountData?.balance ?? accountData?.main_balance ?? null),
        qrisBalance: parseOptionalAmount(accountData?.qris_balance ?? null),
        isEnabled: Boolean(termsData.is_enabled),
        max: parseAmount(termsData.max ?? 0),
        message: readString(termsData.message) || null,
        min: parseAmount(termsData.min ?? 0),
        raw: json,
      };
    } catch (err) {
      if (err instanceof AppOrkutRateLimitError) {
        throw err;
      }
      logger.error({ err, accountCode: account.code }, 'app-orkut: fetchQrisWithdrawTerms error');
      return null;
    }
  }

  async withdrawQris(
    account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>,
    amount: number,
  ): Promise<AppQrisWithdrawResult> {
    const ctx = resolveAppRequestContext(account);
    if (!ctx) {
      throw new Error('Session token / app_reg_id merchant belum valid untuk tarik QRIS.');
    }
    const { parsed, appRegId, phoneUuid } = ctx;

    const timestamp = String(Date.now());
    const signature = buildSignature(timestamp, parsed.tokenSecret);

    const body = new URLSearchParams({
      request_time:          timestamp,
      app_reg_id:            appRegId,
      phone_android_version: PHONE_ANDROID_VER,
      app_version_code:      APP_VERSION_CODE,
      phone_uuid:            phoneUuid,
      auth_username:         parsed.authUsername,
      auth_token:            parsed.authToken,
      app_version_name:      APP_VERSION_NAME,
      ui_mode:               UI_MODE,
      'requests[qris_withdraw][amount]': String(amount),
      phone_model:           PHONE_MODEL,
    });

    try {
      const res = await signedAppFetch(`${APP_BASE}/api/v2/get`, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip',
          Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded',
          Host: 'app.orderkuota.com',
          Signature: signature,
          Timestamp: timestamp,
          'User-Agent': 'okhttp/5.3.2',
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });

      const text = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        logger.warn({ accountCode: account.code, preview: text.slice(0, 300) }, 'app-orkut qris-withdraw: non-JSON');
        throw new Error('Response OrderKuota tidak valid saat tarik QRIS.');
      }

      const withdrawWrapper = json.qris_withdraw as Record<string, unknown> | undefined;
      const nestedMessage = readString(withdrawWrapper?.message);
      if (!res.ok || json.success === false) {
        if (isQrisRateLimited(res.status, json) || nestedMessage.toLowerCase().includes('coba kembali 5 menit')) {
          throw new AppOrkutRateLimitError(
            nestedMessage || readApiMessage(json) || 'OrderKuota menahan akses tarik QRIS sementara',
          );
        }
        return {
          success: false,
          message: nestedMessage || readApiMessage(json) || 'Penarikan QRIS gagal diproses.',
          raw: json,
        };
      }

      const success = typeof withdrawWrapper?.success === 'boolean'
        ? withdrawWrapper.success
        : Boolean(json.success);

      const message = nestedMessage || readApiMessage(json) || (success
        ? 'Penarikan QRIS berhasil diproses.'
        : 'Penarikan QRIS gagal diproses.');

      if (!success && message.toLowerCase().includes('coba kembali 5 menit')) {
        throw new AppOrkutRateLimitError(message);
      }

      return { success, message, raw: json };
    } catch (err) {
      if (err instanceof AppOrkutRateLimitError) {
        throw err;
      }
      logger.error({ err, accountCode: account.code, amount }, 'app-orkut: withdrawQris error');
      throw err;
    }
  }

  async topupMadera(
    account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>,
    amount: number,
  ): Promise<AppMaderaTopupResult> {
    const ctx = resolveAppRequestContext(account);
    if (!ctx) {
      throw new Error('Session token / app_reg_id merchant belum valid untuk topup Madera.');
    }
    const { parsed, appRegId, phoneUuid } = ctx;

    const timestamp = String(Date.now());
    const signature = buildSignature(timestamp, parsed.tokenSecret);

    const body = new URLSearchParams({
      request_time:                   timestamp,
      app_reg_id:                     appRegId,
      phone_android_version:          PHONE_ANDROID_VER,
      app_version_code:               APP_VERSION_CODE,
      phone_uuid:                     phoneUuid,
      auth_username:                  parsed.authUsername,
      auth_token:                     parsed.authToken,
      app_version_name:               APP_VERSION_NAME,
      ui_mode:                        UI_MODE,
      'requests[madera_topup][amount]': String(amount),
      phone_model:                    PHONE_MODEL,
    });

    try {
      const res = await signedAppFetch(`${APP_BASE}/api/v2/get`, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip',
          Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded',
          Host: 'app.orderkuota.com',
          Signature: signature,
          Timestamp: timestamp,
          'User-Agent': 'okhttp/5.3.2',
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });

      const text = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        logger.warn({ accountCode: account.code, preview: text.slice(0, 300) }, 'app-orkut madera-topup: non-JSON');
        throw new Error('Response OrderKuota tidak valid saat topup Madera.');
      }

      const wrapper = json.madera_topup as Record<string, unknown> | undefined;
      const results = (wrapper?.results ?? wrapper) as Record<string, unknown> | undefined;
      const detailsIdRaw = results?.id;
      const detailsId = typeof detailsIdRaw === 'number'
        ? String(detailsIdRaw)
        : readString(detailsIdRaw) || null;
      const nestedMessage = readString(wrapper?.message);

      if (!res.ok || json.success === false) {
        return {
          success: false,
          message: nestedMessage || readApiMessage(json) || 'Topup Madera gagal diproses.',
          detailsId,
          raw: json,
        };
      }

      const success = typeof wrapper?.success === 'boolean'
        ? wrapper.success
        : Boolean(json.success);
      const message = nestedMessage || readApiMessage(json) || (
        success ? 'Topup Madera berhasil diproses.' : 'Topup Madera gagal diproses.'
      );

      return { success, message, detailsId, raw: json };
    } catch (err) {
      logger.error({ err, accountCode: account.code, amount }, 'app-orkut: topupMadera error');
      throw err;
    }
  }

  /**
   * Fetch daftar bank yang didukung untuk transfer Madera via `action=get`.
   * Hasilnya di-cache per account selama 30 menit.
   */
  // ── Nobu/Madera bridge (dipulihkan 7 Jul 2026; sempat ter-wipe deploy lama) ──
  async fetchMaderaTransactionHistory(account: any) {
    try {
      const json = await this.runMaderaTransferRequest(account, { 'requests[madera_history][action]': 'get' } as any, 15000);
      const mh = json && (json as any).madera_history;
      if (!mh || mh.success === false) {
        return { ok: false, message: (mh && mh.message) || 'Gagal mengambil histori Madera.', items: [] };
      }
      const results = Array.isArray(mh.results) ? mh.results : [];
      const items = results.map((r: any) => ({
        type: r.type || null,
        direction: (r.type === 'debet' || r.type === 'debit') ? 'out' : ((r.type === 'kredit' || r.type === 'credit') ? 'in' : null),
        amount: r.amount || null,
        status: r.status || '',
        description: r.description || '',
        date: r.date || '',
        icon: r.icon || null,
      }));
      return { ok: true, title: mh.title || 'Mutasi Madera', fromDate: mh.from_date || null, toDate: mh.to_date || null, items };
    } catch (err) {
      logger.error({ err, accountCode: account.code }, 'app-orkut fetchMaderaTransactionHistory error');
      return { ok: false, message: err instanceof Error ? err.message : 'error', items: [] };
    }
  }

  async fetchMaderaHistoryWebviewUrl(account: any) {
    try {
      const json = await this.runMaderaTransferRequest(account, { 'requests[madera_redirect][action]': 'transactions' } as any, 20000);
      const mr = json && (json as any).madera_redirect;
      if (mr && mr.success !== false && mr.redirect_url) {
        return { ok: true, url: mr.redirect_url };
      }
      return { ok: false, message: (mr && mr.message) || 'Gagal mengambil link webview Madera.' };
    } catch (err) {
      logger.error({ err, accountCode: account.code }, 'app-orkut fetchMaderaHistoryWebviewUrl error');
      return { ok: false, message: err instanceof Error ? err.message : 'error' };
    }
  }

  async captureMaderaHistoryScreenshot(url: string, outPath: string, account: any, amount?: number | null) {
    const { spawnSync } = require('child_process');
    const py = process.env.NOBU_PIN_PYTHON?.trim() || '/opt/ayuchenbot/venv/bin/python3';
    const script = process.env.NOBU_SHOT_SCRIPT?.trim() || 'python/nobu_history_screenshot.py';
    const display = process.env.NOBU_PIN_DISPLAY?.trim() || ':99';
    const cwd = process.env.NOBU_PIN_CWD?.trim() || process.cwd();
    let pin: string | null = null;
    try { if (account && account.transferPinEncrypted) pin = decrypt(account.transferPinEncrypted); } catch (e) { /* ignore */ }
    const input = JSON.stringify({ url, out_path: outPath, pin, amount: amount || null, wait: 10 });
    let res: any;
    try {
      res = spawnSync(py, [script], { cwd, input, encoding: 'utf8', timeout: 160000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, DISPLAY: display } });
    } catch (err: any) {
      return { ok: false, message: 'Screenshot headless gagal dijalankan: ' + (err && err.message) };
    }
    const stdout = String(res.stdout || '');
    const stderr = String(res.stderr || '');
    const m = stdout.match(/SHOT_JSON_BEGIN\s*([\s\S]*?)\s*SHOT_JSON_END/);
    if (!m) {
      logger.warn({ status: res.status, stderr: stderr.slice(0, 400) }, 'app-orkut captureMaderaHistoryScreenshot: no result');
      return { ok: false, message: 'Screenshot tidak mengembalikan hasil.' };
    }
    let parsed: any;
    try { parsed = JSON.parse(m[1].trim()); } catch (err) { return { ok: false, message: 'Hasil screenshot tidak valid.' }; }
    return { ok: Boolean(parsed.success), path: parsed.out_path || outPath, size: parsed.size || 0, message: parsed.message || null };
  }

  async captureMaderaHistoryScreenshotAsync(url: string, outPath: string, account: any, amount?: number | null) {
    const { spawn } = require('child_process');
    const py = process.env.NOBU_PIN_PYTHON?.trim() || '/opt/ayuchenbot/venv/bin/python3';
    const script = process.env.NOBU_SHOT_SCRIPT?.trim() || 'python/nobu_history_screenshot.py';
    const display = process.env.NOBU_PIN_DISPLAY?.trim() || ':99';
    const cwd = process.env.NOBU_PIN_CWD?.trim() || process.cwd();
    let pin: string | null = null;
    try { if (account && account.transferPinEncrypted) pin = decrypt(account.transferPinEncrypted); } catch (e) { /* ignore */ }
    const input = JSON.stringify({ url, out_path: outPath, pin, amount: amount || null, wait: 10 });
    return await new Promise<any>((resolve) => {
      let stdout = '', stderr = '', done = false;
      let timer: any = null;
      const finish = (r: any) => { if (done) return; done = true; try { clearTimeout(timer); } catch (e) { /* ignore */ } resolve(r); };
      let child: any;
      try { child = spawn(py, [script], { cwd, env: { ...process.env, DISPLAY: display } }); }
      catch (err) { finish({ ok: false, message: 'Screenshot headless gagal dijalankan.' }); return; }
      timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } finish({ ok: false, message: 'Screenshot timeout.' }); }, 175000);
      child.stdout.on('data', (d: any) => { stdout += d; });
      child.stderr.on('data', (d: any) => { stderr += d; });
      child.on('error', (err: any) => finish({ ok: false, message: 'spawn error: ' + (err && err.message) }));
      child.on('close', () => {
        const m = stdout.match(/SHOT_JSON_BEGIN\s*([\s\S]*?)\s*SHOT_JSON_END/);
        if (!m) { logger.warn({ stderr: stderr.slice(0, 300) }, 'captureAsync: no result'); finish({ ok: false, message: 'Screenshot tidak mengembalikan hasil.' }); return; }
        let parsed: any; try { parsed = JSON.parse(m[1].trim()); } catch (e) { finish({ ok: false, message: 'Hasil screenshot tidak valid.' }); return; }
        finish({ ok: Boolean(parsed.success), path: parsed.out_path || outPath, size: parsed.size || 0, message: parsed.message || null });
      });
      try { child.stdin.write(input); child.stdin.end(); } catch (e) { /* ignore */ }
    });
  }

  async pingEgress(account: any, timeoutMs?: number) {
    const t = Date.now();
    try {
      await this.runMaderaTransferRequest(account, { 'requests[ping][action]': 'ping' } as any, timeoutMs || 6000);
      return { ok: true, latencyMs: Date.now() - t };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t, message: err instanceof Error ? err.message : 'error' };
    }
  }

  async fetchMaderaBankList(
    account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>,
  ): Promise<Record<string, { name: string; fee: number; status: string }> | null> {
    const cached = bankListCache.get(account.code);
    const canUseCached = Boolean(cached) && Date.now() - (cached?.fetchedAt ?? 0) < BANK_LIST_CACHE_TTL_MS;
    if (canUseCached) {
      return cached?.banks ?? null;
    }

    const overview = await this.fetchMaderaTransferOverview(account);
    return overview?.banks ?? null;
  }

  async fetchMaderaTransferOverview(
    account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>,
  ): Promise<AppMaderaTransferOverview | null> {
    const ctx = resolveAppRequestContext(account);
    if (!ctx) return null;
    const { parsed, appRegId, phoneUuid } = ctx;

    const timestamp = String(Date.now());
    const signature = buildSignature(timestamp, parsed.tokenSecret);
    const body = new URLSearchParams({
      request_time:          timestamp,
      app_reg_id:            appRegId,
      phone_android_version: PHONE_ANDROID_VER,
      app_version_code:      APP_VERSION_CODE,
      phone_uuid:            phoneUuid,
      auth_username:         parsed.authUsername,
      auth_token:            parsed.authToken,
      app_version_name:      APP_VERSION_NAME,
      ui_mode:               UI_MODE,
      phone_model:           PHONE_MODEL,
      'requests[madera_transfer][action]': 'get',
    });

    try {
      const res = await signedAppFetch(`${APP_BASE}/api/v2/get`, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip',
          Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded',
          Host: 'app.orderkuota.com',
          Signature: signature,
          Timestamp: timestamp,
          'User-Agent': 'okhttp/5.3.2',
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });

      const text = await res.text();
      const json = JSON.parse(text) as Record<string, unknown>;
      const wrapper = asRecord(json.madera_transfer);
      const results = asRecord(wrapper?.results);
      const banks = asRecord(results?.banks);
      if (!banks || Object.keys(banks).length === 0) {
        logger.warn({ accountCode: account.code }, 'app-orkut fetchMaderaBankList: empty bank list');
        return null;
      }

      const parsed_banks: Record<string, { name: string; fee: number; status: string }> = {};
      for (const [code, val] of Object.entries(banks)) {
        const info = asRecord(val);
        if (!info) continue;
        parsed_banks[code] = {
          name: readString(info.name) || code,
          fee: parseAmount(info.fee),
          status: readString(info.status) || 'UNKNOWN',
        };
      }

      bankListCache.set(account.code, { banks: parsed_banks, fetchedAt: Date.now() });
      logger.info(
        { accountCode: account.code, bankCount: Object.keys(parsed_banks).length },
        'app-orkut fetchMaderaBankList: bank list cached',
      );
      return {
        accountBalance: parseOptionalAmount(results?.account_balance),
        banks: parsed_banks,
        fee: parseOptionalAmount(results?.fee),
        max: parseOptionalAmount(results?.max),
        message: readApiMessage(json) || null,
        min: parseOptionalAmount(results?.min),
        raw: json,
      };
    } catch (err) {
      logger.warn({ err, accountCode: account.code }, 'app-orkut fetchMaderaBankList: failed');
      return null;
    }
  }

  async inquireBankAccount(
    account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>,
    params: {
      accountNumber: string;
      amount?: number;
      bankCode: string;
      branch?: string;
      remark?: string;
      sourceWallet: 'utama' | 'madera';
    },
  ): Promise<AppBankInquiryResult> {
    const ctx = resolveAppRequestContext(account);
    if (!ctx) {
      throw new Error('Session token / app_reg_id merchant belum valid untuk inquiry rekening.');
    }
    const { parsed, appRegId, phoneUuid } = ctx;

    // Fetch & cache bank list jika belum ada (untuk resolve kode SWIFT)
    if (params.sourceWallet === 'madera') {
      await this.fetchMaderaBankList(account).catch(() => null);
    }

    const timestamp = String(Date.now());
    const signature = buildSignature(timestamp, parsed.tokenSecret);
    const minInquiryAmount = params.sourceWallet === 'madera' ? 10_000 : 1_000;
    const amount = params.amount && params.amount > 0
      ? Math.max(params.amount, minInquiryAmount)
      : minInquiryAmount;
    const body = new URLSearchParams({
      request_time:          timestamp,
      app_reg_id:            appRegId,
      phone_android_version: PHONE_ANDROID_VER,
      app_version_code:      APP_VERSION_CODE,
      phone_uuid:            phoneUuid,
      auth_username:         parsed.authUsername,
      auth_token:            parsed.authToken,
      app_version_name:      APP_VERSION_NAME,
      ui_mode:               UI_MODE,
      phone_model:           PHONE_MODEL,
    });

    const resolvedBank = resolveBankRouting(params.bankCode, account.code);
    const resolvedBankCode = resolvedBank.code;
    const resolvedBankName = resolvedBank.name;

    if (params.sourceWallet === 'madera') {
      body.append('requests[madera_transfer][action]', 'inquiry');
      body.append('requests[madera_transfer][bank]', resolvedBankCode);
      body.append('requests[madera_transfer][bank_name]', resolvedBankName);
      body.append('requests[madera_transfer][account_number]', params.accountNumber);
      body.append('requests[madera_transfer][amount]', String(amount));
      body.append('requests[madera_transfer][get_account_inquiry]', '1');
    } else {
      body.append('requests[send_money][action]', 'check');
      body.append('requests[send_money][bank]', resolvedBankCode);
      body.append('requests[send_money][bank_name]', resolvedBankName);
      body.append('requests[send_money][branch]', params.branch ?? '');
      body.append('requests[send_money][account_number]', params.accountNumber);
      body.append('requests[send_money][amount]', String(amount));
      body.append('requests[send_money][remark]', params.remark ?? '');
      body.append('requests[send_money][get_account_inquiry]', '1');
    }

    try {
      const res = await signedAppFetch(`${APP_BASE}/api/v2/get`, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip',
          Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded',
          Host: 'app.orderkuota.com',
          Signature: signature,
          Timestamp: timestamp,
          'User-Agent': 'okhttp/5.3.2',
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });

      const text = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        logger.warn(
          { accountCode: account.code, sourceWallet: params.sourceWallet, preview: text.slice(0, 300) },
          'app-orkut bank-inquiry: non-JSON',
        );
        throw new Error('Response OrderKuota tidak valid saat inquiry rekening.');
      }

      logger.debug(
        {
          accountCode: account.code,
          sourceWallet: params.sourceWallet,
          bankCode: params.bankCode,
          resolvedBankCode,
          accountNumber: params.accountNumber,
          httpStatus: res.status,
          apiSuccess: json.success,
          apiMessage: readApiMessage(json),
          preview: JSON.stringify(json).slice(0, 500),
        },
        'app-orkut bank-inquiry: API response',
      );

        if (!res.ok || json.success === false) {
          const message = normalizeBankInquiryMessage(
            readApiMessage(json) || 'Inquiry rekening gagal diproses.',
            params.sourceWallet,
          );
        return {
          success: false,
          sourceWallet: params.sourceWallet,
          bankCode: resolvedBankCode || params.bankCode,
          bankName: null,
          accountNumber: params.accountNumber,
            accountName: null,
            fee: null,
            message,
            raw: json,
            sessionId: null,
          };
        }

      if (params.sourceWallet === 'madera') {
        const wrapper = json.madera_transfer as Record<string, unknown> | undefined;
        const results = (wrapper?.results ?? wrapper) as Record<string, unknown> | undefined;
        const success = typeof wrapper?.success === 'boolean'
          ? wrapper.success
          : Boolean(json.success);
        const accountName = readString(results?.account_name) || null;
        const bankName = readString(results?.bank_name) || resolvedBankName || params.bankCode;
        const accountNumber = readString(results?.account_number) || params.accountNumber;
        const bankCode = readString(results?.bank_code) || resolvedBankCode || params.bankCode;
        const fee = parseOptionalAmount(results?.fee);
        const sessionId = readString(results?.session_id)
          || readString(results?.sessionId)
          || readString(results?.trx_id)
          || readString(results?.transaction_id)
          || readString(results?.id)
          || null;
        const rawMessage = readString(wrapper?.message) || readApiMessage(json) || '';
        const message = success && accountName
          ? (rawMessage || null)
          : normalizeBankInquiryMessage(rawMessage, params.sourceWallet);

        logger.info(
          {
            accountCode: account.code,
            bankCode,
            accountName,
            sessionId,
            success,
            resultsKeys: results ? Object.keys(results) : [],
            wrapperKeys: wrapper ? Object.keys(wrapper) : [],
          },
          'app-orkut bank-inquiry madera: parsed result',
        );

        return {
          success: success && Boolean(accountName),
          sourceWallet: params.sourceWallet,
          bankCode,
          bankName,
          accountNumber,
          accountName,
          fee,
          message,
          raw: json,
          sessionId,
        };
      }

      const wrapper = asRecord(json.send_money);
      const success = typeof wrapper?.success === 'boolean'
        ? wrapper.success
        : Boolean(json.success);
      const resultsWrapper = asRecord(wrapper?.results);
      const detail = parseSendMoneyDetail(
        resultsWrapper?.results ?? wrapper?.results ?? resultsWrapper,
        readString(wrapper?.message) || readApiMessage(json) || null,
      );
      const accountName = detail?.accountName || null;
      const bankName = detail?.bankName || resolvedBankName || params.bankCode;
      const accountNumber = detail?.accountNumber || params.accountNumber;
      const bankCode = detail?.bankCode || resolvedBankCode || params.bankCode;
      const fee = detail?.feeUser ?? detail?.fee ?? null;
      const rawMessage = detail?.message || readString(wrapper?.message) || readApiMessage(json) || '';
      const message = success && accountName
        ? (rawMessage || null)
        : normalizeBankInquiryMessage(rawMessage, params.sourceWallet);

      return {
        success: success && Boolean(accountName),
        sourceWallet: params.sourceWallet,
        bankCode,
        bankName,
        accountNumber,
        accountName,
        fee,
        message,
        raw: json,
        sessionId: null,
      };
    } catch (err) {
      logger.error(
        { err, accountCode: account.code, sourceWallet: params.sourceWallet, bankCode: params.bankCode },
        'app-orkut: inquireBankAccount error',
      );
        throw err;
      }
    }

  private async runMaderaTransferRequest(
    account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>,
    entries: Record<string, string>,
    timeoutMs = 20_000,
  ): Promise<Record<string, unknown>> {
    const ctx = resolveAppRequestContext(account);
    if (!ctx) {
      throw new Error('Session token / app_reg_id merchant belum valid untuk transfer Madera.');
    }
    const { parsed, appRegId, phoneUuid } = ctx;
    const timestamp = String(Date.now());
    const signature = buildSignature(timestamp, parsed.tokenSecret);
    const body = new URLSearchParams({
      request_time: timestamp,
      app_reg_id: appRegId,
      phone_android_version: PHONE_ANDROID_VER,
      app_version_code: APP_VERSION_CODE,
      phone_uuid: phoneUuid,
      auth_username: parsed.authUsername,
      auth_token: parsed.authToken,
      app_version_name: APP_VERSION_NAME,
      ui_mode: UI_MODE,
      phone_model: PHONE_MODEL,
    });

    Object.entries(entries).forEach(([key, value]) => body.append(key, value));

    const res = await signedAppFetch(`${APP_BASE}/api/v2/get`, {
      method: 'POST',
      headers: {
        'Accept-Encoding': 'gzip',
        Connection: 'Keep-Alive',
        'Content-Type': 'application/x-www-form-urlencoded',
        Host: 'app.orderkuota.com',
        Signature: signature,
        Timestamp: timestamp,
        'User-Agent': 'okhttp/5.3.2',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await res.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      logger.warn(
        { accountCode: account.code, preview: text.slice(0, 300) },
        'app-orkut madera-transfer: non-JSON response',
      );
      throw new Error('Response OrderKuota tidak valid saat transfer Madera.');
    }
  }

  private parseSimpleHtmlInputs(html: string): Array<{ name: string; value: string; type: string }> {
    const inputs: Array<{ name: string; value: string; type: string }> = [];
    const inputRegex = /<input\b([^>]*?)>/gi;
    let match: RegExpExecArray | null;
    while ((match = inputRegex.exec(html)) !== null) {
      const attrs = match[1] || '';
      const name = /name=["']?([^"' >]+)/i.exec(attrs)?.[1] || '';
      if (!name) continue;
      const value = /value=["']([^"']*)["']/i.exec(attrs)?.[1] || '';
      const type = /type=["']?([^"' >]+)/i.exec(attrs)?.[1]?.toLowerCase() || 'text';
      inputs.push({ name, value, type });
    }
    return inputs;
  }

  private inferPinFieldName(inputs: Array<{ name: string; value: string; type: string }>): string | null {
    const preferredPatterns = [/pin/i, /mpin/i, /passcode/i, /password/i, /otp/i];
    for (const pattern of preferredPatterns) {
      const hit = inputs.find((input) => pattern.test(input.name));
      if (hit) return hit.name;
    }
    const plainText = inputs.find((input) => ['text', 'password', 'tel', 'number'].includes(input.type));
    return plainText?.name ?? null;
  }

  private buildBrowserHeaders(
    account?: Pick<QrisAccount, 'cookiesEncrypted' | 'webCookiesEncrypted' | 'webUserAgent'> | null,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': account?.webUserAgent
        || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    };
    if (account) {
      const cookieSource = account.webCookiesEncrypted ?? account.cookiesEncrypted;
      if (cookieSource) {
        try {
          headers.Cookie = decrypt(cookieSource);
        } catch {
          // proceed without cookies
        }
      }
    }
    return headers;
  }

  async finalizeMaderaTransferPin(
    redirectUrl: string,
    pin: string,
    account?: Pick<QrisAccount, 'cookiesEncrypted' | 'webCookiesEncrypted' | 'webUserAgent'> | null,
  ): Promise<{ success: boolean; message: string | null; raw: Record<string, unknown> }> {
    // Nobu memakai halaman SPA numpad + anti-bot Imperva; submit PIN dilakukan
    // lewat headless browser (undetected-chromedriver + selenium di bawah Xvfb)
    // yang meniru langkah manual (klik numpad 6 digit -> auto verify-pin).
    const cp = await import('child_process');
    const py = process.env.NOBU_PIN_PYTHON?.trim() || '/opt/ayuchenbot/venv/bin/python3';
    const script = process.env.NOBU_PIN_SCRIPT?.trim() || 'python/nobu_pin_finalize.py';
    const display = process.env.NOBU_PIN_DISPLAY?.trim() || ':99';
    const cwd = process.env.NOBU_PIN_CWD?.trim() || process.cwd();
    const input = JSON.stringify({ redirect_url: redirectUrl, pin, dry_run: false });
    let res: ReturnType<typeof cp.spawnSync>;
    try {
      res = cp.spawnSync(py, [script], {
        cwd,
        input,
        encoding: 'utf8',
        timeout: 150_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, DISPLAY: display },
      });
    } catch (err) {
      return { success: false, message: 'Headless PIN gagal dijalankan: ' + (err instanceof Error ? err.message : String(err)), raw: { step: 'spawn_error' } };
    }
    const stdout = String(res.stdout || '');
    const stderr = String(res.stderr || '');
    const m = stdout.match(/FINALIZE_JSON_BEGIN\s*([\s\S]*?)\s*FINALIZE_JSON_END/);
    if (!m) {
      logger.warn({ accountCode: (account as { code?: string } | null | undefined)?.code, status: res.status, stderr: stderr.slice(0, 400) }, 'app-orkut finalizeMaderaTransferPin: headless no result');
      return { success: false, message: 'Konfirmasi PIN headless tidak mengembalikan hasil.', raw: { step: 'no_json', stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) } };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      return { success: false, message: 'Hasil headless tidak valid.', raw: { step: 'bad_json', raw: m[1].slice(0, 400) } };
    }
    logger.info({ accountCode: (account as { code?: string } | null | undefined)?.code, success: parsed.success, message: parsed.message }, 'app-orkut finalizeMaderaTransferPin: headless result');
    return {
      success: Boolean(parsed.success),
      message: (parsed.message as string) || (parsed.success ? 'Konfirmasi PIN berhasil (headless).' : 'Konfirmasi PIN belum berhasil (headless).'),
      raw: { step: 'headless', result: parsed },
    };
  }

  private async fetchSendMoneyHistory(
    account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>,
    id: string,
  ): Promise<AppSendMoneyDetail | null> {
    const ctx = resolveAppRequestContext(account);
    if (!ctx) return null;
    const { parsed, appRegId, phoneUuid } = ctx;

    const timestamp = String(Date.now());
    const signature = buildSignature(timestamp, parsed.tokenSecret);
    const body = new URLSearchParams({
      request_time: timestamp,
      app_reg_id: appRegId,
      phone_android_version: PHONE_ANDROID_VER,
      app_version_code: APP_VERSION_CODE,
      phone_uuid: phoneUuid,
      auth_username: parsed.authUsername,
      auth_token: parsed.authToken,
      app_version_name: APP_VERSION_NAME,
      ui_mode: UI_MODE,
      phone_model: PHONE_MODEL,
      'requests[send_money][action]': 'history',
      'requests[send_money][id]': id,
    });

    try {
      const res = await signedAppFetch(`${APP_BASE}/api/v2/get`, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip',
          Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded',
          Host: 'app.orderkuota.com',
          Signature: signature,
          Timestamp: timestamp,
          'User-Agent': 'okhttp/5.3.2',
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });

      const text = await res.text();
      const json = JSON.parse(text) as Record<string, unknown>;
      const wrapper = asRecord(json.send_money);
      const message = readString(wrapper?.message) || readApiMessage(json) || null;
      if (!res.ok || json.success === false || parseBoolean(wrapper?.success) === false) {
        logger.warn({ accountCode: account.code, id, message }, 'app-orkut send-money history: error response');
        return null;
      }

      const resultCandidates = [
        ...asRecordArray(wrapper?.results),
        ...asRecordArray(asRecord(wrapper?.results)?.results),
      ];
      const detail = parseSendMoneyDetail(resultCandidates[0], message);
      return detail;
    } catch (err) {
      logger.error({ err, accountCode: account.code, id }, 'app-orkut: fetchSendMoneyHistory error');
      return null;
    }
  }

  async transferBankFromUtama(
    account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>,
    params: {
      accountNumber: string;
      amount: number;
      bankCode: string;
      branch?: string;
      remark?: string;
    },
  ): Promise<AppBankTransferResult> {
    const ctx = resolveAppRequestContext(account);
    if (!ctx) {
      throw new Error('Session token / app_reg_id merchant belum valid untuk kirim uang.');
    }
    const { parsed, appRegId, phoneUuid } = ctx;

    const requestBase = {
      app_reg_id: appRegId,
      phone_android_version: PHONE_ANDROID_VER,
      app_version_code: APP_VERSION_CODE,
      phone_uuid: phoneUuid,
      auth_username: parsed.authUsername,
      auth_token: parsed.authToken,
      app_version_name: APP_VERSION_NAME,
      ui_mode: UI_MODE,
      phone_model: PHONE_MODEL,
    };

    const runRequest = async (entries: Record<string, string>, timeoutMs = 20_000): Promise<Record<string, unknown>> => {
      const timestamp = String(Date.now());
      const signature = buildSignature(timestamp, parsed.tokenSecret);
      const body = new URLSearchParams({
        request_time: timestamp,
        ...requestBase,
      });

      Object.entries(entries).forEach(([key, value]) => body.append(key, value));

      const res = await signedAppFetch(`${APP_BASE}/api/v2/get`, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip',
          Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded',
          Host: 'app.orderkuota.com',
          Signature: signature,
          Timestamp: timestamp,
          'User-Agent': 'okhttp/5.3.2',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const text = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        logger.warn(
          { accountCode: account.code, preview: text.slice(0, 300) },
          'app-orkut send-money: non-JSON response',
        );
        throw new Error('Response OrderKuota tidak valid saat kirim uang.');
      }

      if (!res.ok || json.success === false) {
        throw new Error(readApiMessage(json) || 'Request kirim uang ditolak OrderKuota.');
      }

      return json;
    };

    const resolvedCode = resolveBankCode(params.bankCode, account.code);

    try {
      const checkJson = await runRequest({
        'requests[send_money][action]': 'check',
        'requests[send_money][bank]': resolvedCode,
        'requests[send_money][bank_name]': params.bankCode,
        'requests[send_money][branch]': params.branch ?? '',
        'requests[send_money][account_number]': params.accountNumber,
        'requests[send_money][amount]': String(params.amount),
        'requests[send_money][remark]': params.remark ?? '',
        'requests[send_money][get_account_inquiry]': '1',
      });

      const checkWrapper = asRecord(checkJson.send_money);
      const checkResultsWrapper = asRecord(checkWrapper?.results);
      const checkedDetail = parseSendMoneyDetail(
        checkResultsWrapper?.results ?? checkWrapper?.results ?? checkResultsWrapper,
        readString(checkWrapper?.message) || readApiMessage(checkJson) || null,
      );

      const transferId = checkedDetail?.id;
      if (!transferId) {
        return {
          success: false,
          sourceWallet: 'utama',
          status: 'failed',
          referenceNo: null,
          redirectUrl: null,
          bankCode: checkedDetail?.bankCode || params.bankCode,
          bankName: checkedDetail?.bankName || params.bankCode,
          accountNumber: checkedDetail?.accountNumber || params.accountNumber,
          accountName: checkedDetail?.accountName || null,
          fee: checkedDetail?.feeUser ?? checkedDetail?.fee ?? null,
          message: checkedDetail?.message || 'OrderKuota tidak mengembalikan ID transfer.',
          raw: { check: checkJson },
        };
      }

      const historyBefore = await this.fetchSendMoneyHistory(account, transferId);
      const feeValue = historyBefore?.feeUser ?? checkedDetail?.feeUser ?? historyBefore?.fee ?? checkedDetail?.fee ?? 0;
      const info = historyBefore?.note ?? checkedDetail?.note ?? params.remark ?? '';

      const updateJson = await runRequest({
        'requests[send_money][action]': 'update_fee',
        'requests[send_money][id]': transferId,
        'requests[send_money][fee]': String(feeValue),
        'requests[send_money][info]': info,
      });

      const updateWrapper = asRecord(updateJson.send_money);
      const updateSuccess = typeof updateWrapper?.success === 'boolean'
        ? updateWrapper.success
        : Boolean(updateJson.success);
      const updateMessage = readString(updateWrapper?.message) || readApiMessage(updateJson) || null;
      if (!updateSuccess) {
        return {
          success: false,
          sourceWallet: 'utama',
          status: 'failed',
          referenceNo: transferId,
          redirectUrl: null,
          bankCode: historyBefore?.bankCode || checkedDetail?.bankCode || params.bankCode,
          bankName: historyBefore?.bankName || checkedDetail?.bankName || params.bankCode,
          accountNumber: historyBefore?.accountNumber || checkedDetail?.accountNumber || params.accountNumber,
          accountName: historyBefore?.accountName || checkedDetail?.accountName || null,
          fee: feeValue,
          message: updateMessage || 'Konfirmasi biaya transfer gagal diproses.',
          raw: { check: checkJson, historyBefore: historyBefore?.raw ?? null, update: updateJson },
        };
      }

      let historyAfter = await this.fetchSendMoneyHistory(account, transferId);
      if (historyAfter?.status && parseSendMoneyStatus(historyAfter.status) === 'processing') {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        historyAfter = await this.fetchSendMoneyHistory(account, transferId) ?? historyAfter;
      }

      const finalStatus = parseSendMoneyStatus(historyAfter?.status);
      const finalMessage = historyAfter?.message || updateMessage || checkedDetail?.message || 'Transfer bank diproses OrderKuota.';

      return {
        success: finalStatus !== 'failed',
        sourceWallet: 'utama',
        status: finalStatus,
        referenceNo: historyAfter?.referenceNo || transferId,
        redirectUrl: null,
        bankCode: historyAfter?.bankCode || checkedDetail?.bankCode || params.bankCode,
        bankName: historyAfter?.bankName || checkedDetail?.bankName || params.bankCode,
        accountNumber: historyAfter?.accountNumber || checkedDetail?.accountNumber || params.accountNumber,
        accountName: historyAfter?.accountName || checkedDetail?.accountName || null,
        fee: historyAfter?.feeUser ?? historyAfter?.fee ?? feeValue,
        message: finalMessage,
        raw: {
          check: checkJson,
          historyBefore: historyBefore?.raw ?? null,
          update: updateJson,
          historyAfter: historyAfter?.raw ?? null,
        },
      };
    } catch (err) {
      logger.error(
        { err, accountCode: account.code, amount: params.amount, bankCode: params.bankCode },
        'app-orkut: transferBankFromUtama error',
      );
        throw err;
      }
    }

  async transferBankFromMadera(
    account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId' | 'webCookiesEncrypted' | 'webUserAgent'>,
    params: {
      accountName: string;
      accountNumber: string;
      amount: number;
      bankCode: string;
      bankName?: string;
      pin?: string;
      sessionId?: string | null;
    },
  ): Promise<AppBankTransferResult> {
    const requestedBank = resolveBankRouting(params.bankCode, account.code);
    let inquiry = params.sessionId
      ? {
          success: true,
          sourceWallet: 'madera' as const,
          bankCode: requestedBank.code,
          bankName: params.bankName || requestedBank.name,
          accountNumber: params.accountNumber,
          accountName: params.accountName,
          fee: null,
          message: null,
          raw: {},
          sessionId: params.sessionId,
        }
      : await this.inquireBankAccount(account, {
          sourceWallet: 'madera',
          bankCode: params.bankCode,
          accountNumber: params.accountNumber,
          amount: params.amount,
        });

    // Retry sekali kalau inquiry transient-flake (mis. "Nama pemilik rekening belum bisa dibaca").
    if (!params.sessionId && (!inquiry.success || !inquiry.accountName)) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const inquiryRetry = await this.inquireBankAccount(account, {
        sourceWallet: 'madera',
        bankCode: params.bankCode,
        accountNumber: params.accountNumber,
        amount: params.amount,
      });
      if (inquiryRetry.success && inquiryRetry.accountName) inquiry = inquiryRetry;
    }

    if (!inquiry.success || !inquiry.accountName) {
      return {
        success: false,
        sourceWallet: 'madera',
        status: 'failed',
        referenceNo: null,
        redirectUrl: null,
        bankCode: inquiry.bankCode || requestedBank.code || params.bankCode,
        bankName: inquiry.bankName || params.bankName || requestedBank.name || params.bankCode,
        accountNumber: inquiry.accountNumber || params.accountNumber,
        accountName: inquiry.accountName || params.accountName || null,
        fee: inquiry.fee ?? null,
        message: inquiry.message || 'Inquiry rekening Madera gagal.',
        raw: inquiry.raw,
      };
    }

    if (!inquiry.sessionId) {
      logger.warn(
        { accountCode: account.code, bankCode: params.bankCode },
        'app-orkut transferBankFromMadera: no session_id from inquiry, proceeding anyway',
      );
    }

    try {
      const transferEntries: Record<string, string> = {
        'requests[madera_transfer][action]': 'send',
        'requests[madera_transfer][bank]': inquiry.bankCode || requestedBank.code || params.bankCode,
        'requests[madera_transfer][account_number]': inquiry.accountNumber || params.accountNumber,
        'requests[madera_transfer][amount]': String(params.amount),
      };
      if (params.pin) {
        transferEntries['requests[madera_transfer][pin]'] = params.pin;
      }
      const transferJson = await this.runMaderaTransferRequest(account, transferEntries);

      logger.info(
        {
          accountCode: account.code,
          bankCode: params.bankCode,
          amount: params.amount,
          hasPin: Boolean(params.pin),
          hasSessionId: Boolean(inquiry.sessionId),
          transferPreview: JSON.stringify(transferJson).slice(0, 800),
        },
        'app-orkut transferBankFromMadera: transfer response',
      );

      const wrapper = asRecord(transferJson.madera_transfer);
      const results = asRecord(wrapper?.results) || wrapper;
      const success = typeof wrapper?.success === 'boolean'
        ? wrapper.success
        : Boolean(transferJson.success);
      const redirectUrl = readString(results?.redirect_url) || readString(wrapper?.redirect_url) || null;
      const referenceNo = readString(results?.reference_no)
        || readString(results?.transaction_id)
        || readString(results?.ref)
        || readString(results?.id)
        || null;
      const fee = parseOptionalAmount(results?.fee) ?? inquiry.fee ?? null;
      let message = readString(wrapper?.message) || readApiMessage(transferJson) || null;
      if (!success && !redirectUrl && /terjadi kesalahan/i.test(message || '')) {
        message = 'Transfer sementara ditolak Nobu (kemungkinan transaksi sebelumnya belum selesai / sistem sibuk). Tunggu 1-2 menit lalu coba lagi.';
      }
      let finalStatus: 'done' | 'processing' | 'failed' = success ? 'done' : 'failed';
      let finalSuccess = success;
      const raw: Record<string, unknown> = {
        inquiry: inquiry.raw,
        transfer: transferJson,
      };

      if (redirectUrl) {
        finalStatus = 'processing';
        message = message || 'Transfer Madera memerlukan konfirmasi PIN.';
        raw.redirectUrl = redirectUrl;

        if (params.pin) {
          const pinResult = await this.finalizeMaderaTransferPin(redirectUrl, params.pin, account);
          raw.pinConfirmation = pinResult.raw;
          const pinOutcome = (pinResult.raw as { result?: { outcome?: string } } | undefined)?.result?.outcome;
          if (pinResult.success) {
            finalStatus = 'done';
            finalSuccess = true;
            message = pinResult.message || message;
          } else if (pinOutcome === 'failed') {
            // Nobu jelas menolak (mis. "Transaksi Gagal") -> tandai gagal, uang tidak bergerak.
            finalStatus = 'failed';
            finalSuccess = false;
            message = pinResult.message || 'Transaksi gagal diproses Nobu.';
          } else {
            // Status belum pasti (timeout baca halaman) -> processing, cek mutasi.
            finalStatus = 'processing';
            finalSuccess = true;
            message = pinResult.message || message;
          }
        }
      }

      return {
        success: finalSuccess,
        sourceWallet: 'madera',
        status: finalStatus,
        referenceNo,
        redirectUrl,
        bankCode: inquiry.bankCode || requestedBank.code || params.bankCode,
        bankName: inquiry.bankName || params.bankName || requestedBank.name || params.bankCode,
        accountNumber: inquiry.accountNumber || params.accountNumber,
        accountName: inquiry.accountName || params.accountName,
        fee,
        message: message || (finalSuccess ? 'Transfer Madera berhasil diproses.' : 'Transfer Madera gagal diproses.'),
        raw,
      };
    } catch (err) {
      logger.error(
        { err, accountCode: account.code, bankCode: params.bankCode, amount: params.amount },
        'app-orkut: transferBankFromMadera error',
      );
      throw err;
    }
  }

  async fetchQrisMutationDetail(
    account: Pick<QrisAccount, 'code' | 'sessionTokenEncrypted' | 'cookiesEncrypted' | 'deviceId'>,
    mutationId: string | number,
  ): Promise<AppQrisMutationDetail | null> {
    const ctx = resolveAppRequestContext(account);
    if (!ctx) return null;
    const { parsed, appRegId, phoneUuid } = ctx;

    const timestamp = String(Date.now());
    const signature = buildSignature(timestamp, parsed.tokenSecret);

    const body = new URLSearchParams();
    body.append('request_time', timestamp);
    body.append('app_reg_id', appRegId);
    body.append('phone_android_version', PHONE_ANDROID_VER);
    body.append('app_version_code', APP_VERSION_CODE);
    body.append('phone_uuid', phoneUuid);
    body.append('requests[qris_details][id]', String(mutationId));
    body.append('auth_username', parsed.authUsername);
    body.append('auth_token', parsed.authToken);
    body.append('app_version_name', APP_VERSION_NAME);
    body.append('ui_mode', UI_MODE);
    body.append('phone_model', PHONE_MODEL);

    try {
      const res = await signedAppFetch(`${APP_BASE}/api/v2/get`, {
        method: 'POST',
        headers: {
          'Accept-Encoding': 'gzip', Connection: 'Keep-Alive',
          'Content-Type': 'application/x-www-form-urlencoded',
          Host: 'app.orderkuota.com', Signature: signature, Timestamp: timestamp,
          'User-Agent': 'okhttp/5.3.2',
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });

      const text = await res.text();
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        logger.warn(
          { accountCode: account.code, mutationId, preview: text.slice(0, 200) },
          'app-orkut qris-details: non-JSON response',
        );
        return null;
      }

      if (!res.ok || json.success === false) {
        if (isQrisRateLimited(res.status, json)) {
          throw new AppOrkutRateLimitError(readApiMessage(json) || 'OrderKuota menahan akses detail QRIS sementara');
        }
        logger.warn(
          { accountCode: account.code, mutationId, status: res.status },
          'app-orkut qris-details: error response',
        );
        return null;
      }

      const wrapper = json.qris_details as Record<string, unknown> | undefined;
      const results = (wrapper?.results ?? wrapper) as Record<string, unknown> | undefined;
      if (!results) {
        logger.warn({ accountCode: account.code, mutationId }, 'app-orkut qris-details: results not found');
        return null;
      }

      return {
        amount: parseAmount(results.amount ?? null) || null,
        amountNett: parseAmount(results.amount_nett ?? null) || null,
        brandName: readString(results.brand_name) || null,
        cpan: readString(results.cpan) || null,
        displayTime: readString(results.date) || null,
        feeText: readString(results.fee) || null,
        mid: readString(results.mid) || null,
        mpan: readString(results.mpan) || null,
        nmid: readString(results.nmid) || null,
        raw: results,
        rawId: readString(results.id) || String(mutationId),
        rrn: readString(results.issuer_ref) || null,
        senderName: readString(results.buyer_ref) || null,
        statusCode: normalizeAppStatus(results.type),
      };
    } catch (err) {
      if (err instanceof AppOrkutRateLimitError) {
        throw err;
      }
      logger.error({ err, accountCode: account.code, mutationId }, 'app-orkut: fetchQrisMutationDetail error');
      return null;
    }
  }

  async generateQr(
    _account: QrisAccount,
    _finalAmount: number,
    _note: string,
  ): Promise<QrGenerationResult> {
    throw new Error('AppOrkutGateway.generateQr: not yet implemented');
  }

  async recheckTransaction(_qrId: string, _account: QrisAccount): Promise<RecheckResult> {
    throw new Error('AppOrkutGateway.recheckTransaction: not yet implemented');
  }
}

export const appGateway = new AppOrkutGateway();
