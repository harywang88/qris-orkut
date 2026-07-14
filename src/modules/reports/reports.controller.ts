import { Request, Response } from 'express';
import { db } from '../../config/database';
import { logger } from '../../config/logger';
import { listSites, getAccountSiteMap } from '../../shared/site.service';
import { pendingMoneyTotal, crossDayPendingBooking } from '../../shared/pending-money.service';
import { getSiteScopeForUser, isMasterUser } from '../../shared/alias-access.service';
import { runWithScope } from '../../core/request-context';
import { getOpeningAnchor, setOpeningAnchor, setOpeningAnchorAuto, isAutoAnchor, listOpeningAnchors, getBaseline, getStatusOverride, getPencairanOverride, getFee3Override, setPencairanOverride, setFee3Override, getAccountModal, setAccountModal, getFeeAdjust, getAccountSiteMigrations, isHideNewAccounts } from '../../shared/report-opening-balance.service';

// FIX #1: Batas hari dihitung dalam WIB (Asia/Jakarta, UTC+7), BUKAN zona server (UTC).
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
function startOfDayWib(d: Date): Date {
  const wib = new Date(d.getTime() + WIB_OFFSET_MS);
  const wibMidnightUtc = Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate(), 0, 0, 0, 0);
  return new Date(wibMidnightUtc - WIB_OFFSET_MS);
}
function endOfDayWib(d: Date): Date {
  return new Date(startOfDayWib(d).getTime() + 86400000 - 1);
}
// Label DD/MM dalam WIB untuk sumbu grafik.
function wibDayLabel(instant: Date): string {
  const wib = new Date(instant.getTime() + WIB_OFFSET_MS);
  return `${String(wib.getUTCDate()).padStart(2, '0')}/${String(wib.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ── Helper ekstraksi fee dari MUTASI (port dari view qris.ejs getServiceFee & utama.ejs feeAmount) ──
type FeeMut = { amount: number; rawDataJson: string; qrisAccountId: string; description?: string | null };

function _parseMoneyLike(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(Math.round(value));
  let text = String(value).trim();
  if (!text) return 0;
  text = text.replace(/rp/gi, '').replace(/\s+/g, '').replace(/[^0-9,.-]/g, '');
  if (!text) return 0;
  text = text.replace(/\./g, '').replace(/,/g, '.');
  const parsed = Number(text);
  return Number.isFinite(parsed) ? Math.abs(Math.round(parsed)) : 0;
}
function _parseRaw(m: { rawDataJson: string }): Record<string, unknown> {
  try {
    return (JSON.parse(m.rawDataJson || '{}') as Record<string, unknown>) || {};
  } catch {
    return {};
  }
}
function _descOf(m: FeeMut): string {
  const raw = _parseRaw(m);
  return String(m.description || raw.keterangan || raw.description || raw.note || '-').trim();
}
// QRIS "Biaya Layanan" (0,3% OrderKuota utk bayar >500rb).
function qrisServiceFee(m: FeeMut): number {
  const raw = _parseRaw(m);
  const direct = _parseMoneyLike(
    raw.fee_user ?? raw.feeUser ?? raw.fee ?? raw.admin ?? raw.biaya_layanan ?? raw.biayaLayanan,
  );
  if (direct > 0) return direct;
  const nett = _parseMoneyLike(raw.amount_nett ?? raw.amountNett);
  if (nett > 0 && (m.amount || 0) > nett) return Math.max(0, Math.round((m.amount || 0) - nett));
  return 0;
}
// Utama "Biaya Percepatan Pencairan QRIS / Biaya QRIS 1%".
function utamaOnePercentFee(m: FeeMut): number {
  const raw = _parseRaw(m);
  const c = [raw.biaya_percepatan_pencairan_qris, raw.biaya_percepatan, raw.biaya_pencairan, raw.service_fee, raw.fee];
  for (const x of c) {
    if (x === null || x === undefined) continue;
    const p = Number(String(x).replace(/[^\d-]/g, ''));
    if (Number.isFinite(p) && p > 0) return p;
  }
  const t = _descOf(m).toLowerCase();
  const feeRow =
    t.includes('biaya percepatan pencairan qris') ||
    (t.includes('biaya percepatan') && t.includes('qris')) ||
    t.includes('biaya percepatan pencairan');
  return feeRow ? Math.abs(Number(m.amount || 0)) : 0;
}
// Madera "Biaya Transfer BI-Fast" (biaya settlement Madera->bank), FLAT per transfer.
function maderaTransferFee(m: FeeMut): number {
  const t = _descOf(m).toLowerCase();
  return (t.includes('biaya transfer bi fast') || t.includes('biaya transfer bi-fast') || (t.includes('biaya transfer') && t.includes('bi fast'))) ? Math.abs(Number(m.amount || 0)) : 0;
}
// Madera "Bunga Tabungan" (pemasukan bunga bank), type credit.
function maderaBungaAmount(m: FeeMut): number {
  const t = _descOf(m).toLowerCase();
  return (t.includes('bunga tabungan') || (t.includes('bunga') && t.includes('tabungan'))) ? Math.abs(Number(m.amount || 0)) : 0;
}
function _sumFee(map: Record<string, number>, accIds: string[]): number {
  return accIds.reduce((s, id) => s + (map[id] || 0), 0);
}

/**
 * GET /reports — Full report page: filter tanggal + rincian per SITE + FEE/FEE2.
 */
export async function showReports(req: Request, res: Response): Promise<void> {
  try {
    const today = new Date();
    const range = (req.query.range as string) || 'today';
    let from: Date;
    let to: Date;
    if (range === 'yesterday') {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      from = startOfDayWib(yesterday);
      to = endOfDayWib(yesterday);
    } else if (range === 'custom' && req.query.from && req.query.to) {
      from = startOfDayWib(new Date(req.query.from as string));
      to = endOfDayWib(new Date(req.query.to as string));
      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        from = startOfDayWib(today);
        to = endOfDayWib(today);
      }
    } else {
      from = startOfDayWib(today);
      to = endOfDayWib(today);
    }

    // ── Per-SITE breakdown (Site = unit bisnis; diturunkan dari AKUN via site.service) ──
    // Fase 6: alias-tenant -> paksa lihat site-nya saja (abaikan ?site= dari query).
    const _aliasScope = getSiteScopeForUser(req.session.user);
    // LAPORAN scope SADAR-TANGGAL (report-only): alias-tenant lihat akun yg site-nya (migrasi-adjusted)
    // = site-nya PADA tanggal laporan. 12 Jul: sulebet lihat akun eks-nya (spt master); 13 Jul+: isolasi
    // ketat antar-tenant. Master (_aliasScope null) tanpa filter. Override HANYA di laporan (menu lain
    // tetap pakai scope assignment-kini dari middleware app.ts).
    const _reportScope: string[] | null = (() => {
      if (!_aliasScope) return null;
      const _rw = getAccountSiteMap();
      const _mg = getAccountSiteMigrations();
      const _wd = (d: Date): string => { const w = new Date(d.getTime() + 7 * 3600 * 1000); return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, '0')}-${String(w.getUTCDate()).padStart(2, '0')}`; };
      const _rd = _wd(from);
      const _out: string[] = [];
      for (const _id of new Set<string>([...Object.keys(_rw), ...Object.keys(_mg)])) {
        const _m = _mg[_id];
        const _s = (_m && _m.site && _m.before && _rd < _m.before) ? _m.site : _rw[_id];
        if (_s === _aliasScope) _out.push(_id);
      }
      return _out;
    })();
    await runWithScope({ scopeAccountIds: _reportScope }, async () => {
    const sites = _aliasScope ? listSites().filter((s) => s.id === _aliasScope) : listSites();
    const accountsAll = await db.qrisAccount.findMany({ select: { id: true } });
    const accSiteMap: Record<string, string> = { ...getAccountSiteMap() };
    // MIGRASI SITE sadar-tanggal: akun yg pindah site tetap dihitung di site LAMA utk tanggal SEBELUM
    // tgl pindah (mis. Sulebet->ASDTOTO 13 Jul: 12 Jul & sebelumnya = Sulebet). Single-day pakai tgl `from`.
    {
      const _wibD = (d: Date): string => { const w = new Date(d.getTime() + 7 * 3600 * 1000); return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, '0')}-${String(w.getUTCDate()).padStart(2, '0')}`; };
      const _repDate = _wibD(from);
      const _migs = getAccountSiteMigrations();
      for (const _aid of Object.keys(_migs)) {
        const _m = _migs[_aid];
        if (_m && _m.site && _m.before && _repDate < _m.before) accSiteMap[_aid] = _m.site;
      }
    }
    const noneAccountIds = accountsAll.filter((a) => !accSiteMap[a.id]).map((a) => a.id);
    const hasNoneBucket = noneAccountIds.length > 0;
    const siteBuckets = sites
      .map((s) => ({
        key: s.id,
        name: s.name,
        accountIds: accountsAll.filter((a) => accSiteMap[a.id] === s.id).map((a) => a.id),
      }))
      .filter((b) => b.accountIds.length > 0);
    const allBuckets = siteBuckets.slice();
    if (hasNoneBucket) allBuckets.push({ key: 'none', name: 'Tanpa site', accountIds: noneAccountIds });
    // '' = Semua Site (gabungan), siteId, atau 'none'. Alias-tenant dipaksa ke site-nya.
    const selectedSite = _aliasScope || (typeof req.query.site === 'string' ? req.query.site : '');
    let restrictAccountIds: string[] | null = null;
    if (selectedSite) {
      const sb = allBuckets.find((x) => x.key === selectedSite);
      restrictAccountIds = sb ? sb.accountIds : [];
    }
    // HIDE akun-baru (onboarding) utk tanggal ber-flag: dikeluarkan dari SEMUA agregat overall (nominal,
    // hitung, chart, fee, saldo, modal, mini-row) → TOTAL = baris SITE saja. Set diisi setelah _newAccIds
    // dihitung (lihat _hideNewIds di bawah); withAccount = closure, membacanya saat query dijalankan.
    const _hideNewSet = new Set<string>();
    const withAccount = (w: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = restrictAccountIds ? { ...w, qrisAccountId: { in: restrictAccountIds } } : { ...w };
      if (_hideNewSet.size > 0) {
        const cur = out.qrisAccountId as { in?: string[] } | undefined;
        if (cur && Array.isArray(cur.in)) out.qrisAccountId = { in: cur.in.filter((id) => !_hideNewSet.has(id)) };
        else out.qrisAccountId = { notIn: [..._hideNewSet] };
      }
      return out;
    };
    const bucketsToShow = selectedSite ? allBuckets.filter((b) => b.key === selectedSite) : allBuckets;

    // FEE (QRIS Biaya Layanan) + FEE2 (Utama 1%) dari MUTASI (transactionTime dalam periode), per akun.
    const [_qrisMuts, _utamaMuts, _maderaMuts] = await Promise.all([
      db.mutation.findMany({
        where: { walletCategory: 'qris', transactionTime: { gte: from, lte: to } },
        select: { amount: true, rawDataJson: true, qrisAccountId: true },
      }),
      db.mutation.findMany({
        where: { walletCategory: 'utama', transactionTime: { gte: from, lte: to } },
        select: { amount: true, rawDataJson: true, qrisAccountId: true },
      }),
      db.mutation.findMany({
        where: { walletCategory: 'madera', transactionTime: { gte: from, lte: to } },
        select: { amount: true, rawDataJson: true, qrisAccountId: true },
      }),
    ]);
    const feeQrisByAcc: Record<string, number> = {};
    for (const m of _qrisMuts) {
      if (m.qrisAccountId) feeQrisByAcc[m.qrisAccountId] = (feeQrisByAcc[m.qrisAccountId] || 0) + qrisServiceFee(m);
    }
    const feeUtamaByAcc: Record<string, number> = {};
    for (const m of _utamaMuts) {
      if (m.qrisAccountId) feeUtamaByAcc[m.qrisAccountId] = (feeUtamaByAcc[m.qrisAccountId] || 0) + utamaOnePercentFee(m);
    }
    const feeMaderaByAcc: Record<string, number> = {};
    const bungaMaderaByAcc: Record<string, number> = {};
    for (const m of _maderaMuts) {
      if (m.qrisAccountId) { feeMaderaByAcc[m.qrisAccountId] = (feeMaderaByAcc[m.qrisAccountId] || 0) + maderaTransferFee(m); bungaMaderaByAcc[m.qrisAccountId] = (bungaMaderaByAcc[m.qrisAccountId] || 0) + maderaBungaAmount(m); }
    }
    const _allReportAccIds = restrictAccountIds || accountsAll.map((a) => a.id);

    // ── Saldo Awal/Akhir (hitung-mundur dari saldo terkini) + Pencairan + Direct Debit per akun ──
    // saldo_asof(T) = saldoTerkini - Σ delta(mutasi transactionTime > T). delta order-independent (anti-artefak urutan).
    const _balAccounts = await db.qrisAccount.findMany({
      select: { id: true, lastQrisBalance: true, lastMainBalance: true, lastMaderaBalance: true, createdAt: true, code: true },
    });
    const _balMuts = await db.mutation.findMany({
      where: { transactionTime: { gte: from } },
      select: { qrisAccountId: true, walletCategory: true, amount: true, type: true, balanceAfter: true, balanceBefore: true, transactionTime: true, rawDataJson: true },
    });
    const _accW: Record<string, { from: number; afterTo: number }> = {};
    const _madOut: Record<string, { pencairan: number; directDebit: number }> = {};
    for (const m of _balMuts) {
      if (!m.qrisAccountId || !m.walletCategory) continue;
      const _d = (m.balanceAfter !== 0 || m.balanceBefore !== 0) ? (m.balanceAfter - m.balanceBefore) : (m.type === 'credit' ? m.amount : -m.amount);
      const _k = m.qrisAccountId + '|' + m.walletCategory;
      const _e = _accW[_k] || (_accW[_k] = { from: 0, afterTo: 0 });
      _e.from += _d;
      if (m.transactionTime > to) _e.afterTo += _d;
      if (m.walletCategory === 'madera' && m.type === 'debit' && m.transactionTime >= from && m.transactionTime <= to) {
        const _raw = _parseRaw({ rawDataJson: m.rawDataJson });
        const _dsc = String(_raw.keterangan || _raw.description || '').toUpperCase();
        const _mo = _madOut[m.qrisAccountId] || (_madOut[m.qrisAccountId] = { pencairan: 0, directDebit: 0 });
        if (_dsc.includes('BI FAST OUT')) _mo.pencairan += Math.abs(m.amount);
        else if (_dsc.includes('DIRECT DEBIT')) _mo.directDebit += Math.abs(m.amount);
      }
    }
    const _curBal: Record<string, { qris: number; utama: number; madera: number }> = {};
    for (const a of _balAccounts) _curBal[a.id] = { qris: a.lastQrisBalance || 0, utama: a.lastMainBalance || 0, madera: a.lastMaderaBalance || 0 };
    const _codeMap: Record<string, string> = {};
    for (const a of _balAccounts) _codeMap[a.id] = a.code || a.id;
    const _asofAcc = (accId: string, mode: 'awal' | 'akhir'): number => {
      const _c = _curBal[accId] || { qris: 0, utama: 0, madera: 0 };
      let _b = 0;
      (['qris', 'utama', 'madera'] as const).forEach((_w) => {
        const _e = _accW[accId + '|' + _w] || { from: 0, afterTo: 0 };
        _b += _c[_w] - (mode === 'awal' ? _e.from : _e.afterTo);
      });
      return _b;
    };
    const _siteBal = (accIds: string[]) => {
      let awal = 0, akhir = 0, pencairan = 0, directDebit = 0;
      for (const id of accIds) {
        awal += _asofAcc(id, 'awal');
        akhir += _asofAcc(id, 'akhir');
        const _mo = _madOut[id];
        if (_mo) { pencairan += _mo.pencairan; directDebit += _mo.directDebit; }
      }
      return { awal, akhir, pencairan, directDebit };
    };

    // REPORT_ANCHOR_8: Saldo Awal Manual (jangkar) — override walk-back rapuh (Madera balanceAfter=0).
    const _wibDateStr = (d: Date): string => { const w = new Date(d.getTime() + WIB_OFFSET_MS); return `${w.getUTCFullYear()}-${String(w.getUTCMonth() + 1).padStart(2, '0')}-${String(w.getUTCDate()).padStart(2, '0')}`; };
    const _awalDate = _wibDateStr(from);
    const _akhirDate = _wibDateStr(new Date(to.getTime() + 1));
    const _anchorAwal = (scope: string): number | null => getOpeningAnchor(scope, _awalDate);
    const _anchorAkhir = (scope: string): number | null => getOpeningAnchor(scope, _akhirDate);
    const _isSingleDay = _awalDate === _wibDateStr(to);
    // ONBOARDING: akun dgn createdAt = tanggal laporan (hari operasi pertama). Hanya utk tampilan 1 hari.
    // Modal = walk-back "awal" akun baru = saldo saat ditambah (transaksi sebelum createdAt sudah disaring di ingest).
    const _newAccIds = new Set<string>(_isSingleDay ? _balAccounts.filter((a) => _wibDateStr(a.createdAt) === _awalDate).map((a) => a.id) : []);
    // HIDE akun-baru (onboarding) utk tanggal ber-flag (mis. 10 Jul): keluarkan akun createdAt=tanggal-ini
    // dari SEMUA agregat overall (via _hideNewSet dibaca withAccount + overallAccIds terfilter) → TOTAL = baris
    // SITE saja, mini-row kosong. HIDE bukan DELETE (data akun/mutasi utuh; hapus flag = tampil lagi). 1 hari saja.
    const _hideNew = _isSingleDay && isHideNewAccounts(_awalDate);
    if (_hideNew) for (const _id of _newAccIds) _hideNewSet.add(_id);
    const overallAccIds = _allReportAccIds.filter((id) => !_hideNewSet.has(id));
    // MODAL akun baru = saldo PASTI saat ditambah (angka dikunci, BUKAN walk-back rapuh).
    // Auto-capture default = saldo tepat sebelum transaksi PERTAMA (>= createdAt) per wallet; tersimpan sekali, editable master.
    const _firstBBAfterCreate: Record<string, { qris?: number; utama?: number; madera?: number; qrisT?: number; utamaT?: number; maderaT?: number }> = {};
    if (_newAccIds.size > 0) {
      const _createdAtMap: Record<string, Date> = {};
      for (const a of _balAccounts) _createdAtMap[a.id] = a.createdAt;
      for (const m of _balMuts) {
        if (!m.qrisAccountId || !m.walletCategory || !_newAccIds.has(m.qrisAccountId)) continue;
        const cAt = _createdAtMap[m.qrisAccountId];
        if (!cAt || m.transactionTime < cAt) continue;
        const _w = m.walletCategory as 'qris' | 'utama' | 'madera';
        const e = _firstBBAfterCreate[m.qrisAccountId] || (_firstBBAfterCreate[m.qrisAccountId] = {});
        const tKey = (_w + 'T') as 'qrisT' | 'utamaT' | 'maderaT';
        const tMs = m.transactionTime.getTime();
        if (e[tKey] === undefined || tMs < (e[tKey] as number)) { e[_w] = m.balanceBefore; e[tKey] = tMs; }
      }
    }
    const _anchorModal = (accId: string): number => {
      const cur = _curBal[accId] || { qris: 0, utama: 0, madera: 0 };
      const f = _firstBBAfterCreate[accId] || {};
      // Clamp per-wallet >= 0: modal = injeksi saldo, tak boleh negatif (saldo QRIS bisa sempat minus krn timing fee).
      return Math.max(0, f.qris ?? cur.qris) + Math.max(0, f.utama ?? cur.utama) + Math.max(0, f.madera ?? cur.madera);
    };
    const _modalOf = (accId: string): number => {
      const stored = getAccountModal(accId);
      if (stored != null) return stored;
      const a = _anchorModal(accId);
      setAccountModal(accId, a); // rekam sekali (auto-capture), lalu dikunci
      return a;
    };
    const _modalFor = (accIds: string[]): number => accIds.reduce((sm, id) => sm + (_newAccIds.has(id) ? _modalOf(id) : 0), 0);
    // REPORT_BASELINE: baris Laporan pakai baseline (fixed 'awal operasional') bila ada utk hari itu;
    // jika tidak, Saldo Akhir = RUMUS (Awal + Nominal + Pending - Fee - Fee2 - Fee3 - Pencairan). Awal = jangkar bila ada.
    const _resolveReportRow = (scope: string, live: { nominal: number; pending: number; fee: number; fee2: number; fee3: number; bunga: number; modalMasuk: number; pencairan: number; walkbackAwal: number }) => {
      const base = _isSingleDay ? getBaseline(scope, _awalDate) : null;
      if (base) {
        return { nominal: base.nominal, pending: base.pending, fee: base.fee, fee2: base.fee2, fee3: base.fee3, modalMasuk: 0, pencairan: base.pencairan, saldoAwal: base.saldoAwal, saldoAkhir: base.saldoAkhir, manual: true, isBaseline: true };
      }
      const saldoAwal = _anchorAwal(scope) ?? live.walkbackAwal;
      const _pcr = getPencairanOverride(scope, _awalDate) ?? live.pencairan;
      const _fee3 = getFee3Override(scope, _awalDate) ?? live.fee3;
      const saldoAkhir = saldoAwal + live.nominal + live.pending - live.fee - live.fee2 - _fee3 + live.bunga + live.modalMasuk - _pcr;
      return { nominal: live.nominal, pending: live.pending, fee: live.fee, fee2: live.fee2, fee3: _fee3, modalMasuk: live.modalMasuk, pencairan: _pcr, saldoAwal, saldoAkhir, manual: _anchorAwal(scope) != null, isBaseline: false, pencairanManual: getPencairanOverride(scope, _awalDate) != null, fee3Manual: getFee3Override(scope, _awalDate) != null };
    };
    // STATUS_MATCH (11 Jul): Status = Saldo Akhir (rumus) vs saldo FISIK (Grand Total scope) utk hari
    // BERJALAN. Baseline/lampau/range -> match (angka koko / by-construction). Override manual tetap prioritas.
    const _isCurrentDay = _isSingleDay && _awalDate === _wibDateStr(new Date());
    const _sumBalance = (accIds: string[]): number => accIds.reduce((sm, id) => { const c = _curBal[id]; return sm + (c ? c.qris + c.utama + c.madera : 0); }, 0);
    const _statusFor = (row: { saldoAkhir: number; isBaseline: boolean }, accIds: string[]): 'match' | 'unmatch' => {
      if (row.isBaseline || !_isCurrentDay) return 'match';
      const phys = _sumBalance(accIds);
      const tol = Math.max(50000, Math.round(Math.abs(phys) * 0.01));
      return Math.abs(row.saldoAkhir - phys) <= tol ? 'match' : 'unmatch';
    };
    // PENDING_CARRY: pending_booking lintas-hari -> keluar dari omset (Nominal).
    const _pbRows = await db.transaction.findMany({
      where: { statusPay: 'paid', paidAt: { gte: from, lte: to }, metadataJson: { contains: 'pending_booking' }, ...(restrictAccountIds ? { qrisAccountId: { in: restrictAccountIds } } : {}) },
      select: { qrisAccountId: true, finalAmount: true, paidAt: true, metadataJson: true },
    });
    const _crossDay = crossDayPendingBooking(_pbRows);
    const siteBreakdown = await Promise.all(
      bucketsToShow.map(async (b) => {
        const _accIds = b.accountIds.filter((id) => !_newAccIds.has(id)); // ONBOARDING: akun baru keluar dari baris SITE (jadi mini-row), tetap dihitung di TOTAL
        const baseWhere = { qrisAccountId: { in: _accIds }, createdAt: { gte: from, lte: to } };
        const [total, paid, expired, depositSuccess, depositFailed, manualReview, paidAgg] = await Promise.all([
          db.transaction.count({ where: baseWhere }),
          db.transaction.count({ where: { ...baseWhere, statusPay: 'paid' } }),
          db.transaction.count({ where: { ...baseWhere, statusPay: 'expired' } }),
          db.transaction.count({ where: { ...baseWhere, statusBot: 'deposit_success' } }),
          db.transaction.count({ where: { ...baseWhere, statusBot: 'deposit_failed' } }),
          db.transaction.count({ where: { ...baseWhere, statusBot: 'manual_review' } }),
          // FIX #2: uang (nominal + fee) by paidAt (tanggal DIBAYAR) agar COCOK dgn grafik.
          db.transaction.aggregate({
            where: { qrisAccountId: { in: _accIds }, statusPay: 'paid', paidAt: { gte: from, lte: to } },
            _sum: { finalAmount: true, feeAmount: true },
          }),
        ]);
        const totalPaid = paidAgg._sum.finalAmount ?? 0;
        const totalFee = _sumFee(feeQrisByAcc, _accIds);
        const fee2 = _sumFee(feeUtamaByAcc, _accIds);
        const fee3 = _sumFee(feeMaderaByAcc, _accIds);
        const bunga = _sumFee(bungaMaderaByAcc, _accIds);
        const _sb = _siteBal(_accIds);
        // Koreksi manual Fee/Fee2 per SITE (mis. pengeluaran handover akun pindah site) + note.
        const _sfa = getFeeAdjust('site:' + b.key, _awalDate);
        const _feeUse = _sfa && _sfa.fee != null ? _sfa.fee : totalFee;
        const _fee2Use = _sfa && _sfa.fee2 != null ? _sfa.fee2 : fee2;
        const _net = totalPaid - _feeUse - _fee2Use - fee3;
        // RECONCILE STATUS (fix 11 Jul): FEE Biaya Layanan QRIS (totalFee) TIDAK memotong saldo
        // wallet -- saldo QRIS diterima GROSS, terbukti tak ada baris 'biaya layanan' & delta saldo
        // = nominal penuh. Kalau ikut dikurangi, tiap akun meleset persis sebesar FEE-nya (double
        // count). Untuk cek keseimbangan SALDO, kurangi hanya fee yang benar-benar keluar saldo:
        // fee2 (Utama 1%) + fee3 (transfer Madera). NET tampilan tetap pakai _net (net bisnis).
        // Toleransi 0,1% NET (min Rp10.000) meredam skew tengah malam (paidAt vs waktu mutasi).
        const _pend = (await pendingMoneyTotal(from, to, _accIds)).total;
        const _crossSite = _sumFee(_crossDay.byAccount, _accIds);
        const _row = _resolveReportRow('site:' + b.key, { nominal: totalPaid - _crossSite, pending: _pend, fee: _feeUse, fee2: _fee2Use, fee3, bunga, modalMasuk: 0, pencairan: _sb.pencairan, walkbackAwal: _sb.awal });
        const _status = (getStatusOverride('site:' + b.key, _awalDate) ?? getStatusOverride('*', _awalDate)) ?? _statusFor(_row, _accIds);
        return {
          siteName: b.name,
          siteKey: b.key,
          accountCount: _accIds.length,
          total,
          paid,
          expired,
          open: total - paid - expired,
          depositSuccess,
          depositFailed,
          manualReview,
          totalPaid: _row.nominal,
          pending: _row.pending,
          totalFee: _row.fee,
          feeNote: (_sfa && _sfa.feeNote) || null,
          fee2: _row.fee2,
          fee2Note: (_sfa && _sfa.fee2Note) || null,
          fee3: _row.fee3,
          bunga,
          modalMasuk: _row.modalMasuk,
          saldoAwal: _row.saldoAwal,
          saldoAkhir: _row.saldoAkhir,
          saldoAwalManual: _row.manual,
          isBaseline: _row.isBaseline,
          pendingCarryProcessed: _row.isBaseline ? 0 : _crossSite,
          pencairan: _row.pencairan,
          pencairanManual: _row.pencairanManual,
          fee3Manual: _row.fee3Manual,
          netAmount: _net,
          status: _status,
        };
      }),
    );

    // Overall totals (hormati filter site)
    const overallWhere = withAccount({ createdAt: { gte: from, lte: to } });
    const [totalAll, paidAll, expiredAll, openAll, depSuccessAll, depFailedAll, manualReviewAll, paidAggAll] =
      await Promise.all([
        db.transaction.count({ where: overallWhere }),
        db.transaction.count({ where: { ...overallWhere, statusPay: 'paid' } }),
        db.transaction.count({ where: { ...overallWhere, statusPay: 'expired' } }),
        db.transaction.count({ where: { ...overallWhere, statusPay: 'open' } }),
        db.transaction.count({ where: { ...overallWhere, statusBot: 'deposit_success' } }),
        db.transaction.count({ where: { ...overallWhere, statusBot: 'deposit_failed' } }),
        db.transaction.count({ where: { ...overallWhere, statusBot: 'manual_review' } }),
        db.transaction.aggregate({
          where: withAccount({ statusPay: 'paid', paidAt: { gte: from, lte: to } }),
          _sum: { finalAmount: true, feeAmount: true },
        }),
      ]);
    const overallTotalPaid = paidAggAll._sum.finalAmount ?? 0;
    const overallTotalFee = _sumFee(feeQrisByAcc, overallAccIds);
    const overallFee2 = _sumFee(feeUtamaByAcc, overallAccIds);
    const overallFee3 = _sumFee(feeMaderaByAcc, overallAccIds);
    const overallBunga = _sumFee(bungaMaderaByAcc, overallAccIds);
    const _osb = _siteBal(overallAccIds);
    const _onet = overallTotalPaid - overallTotalFee - overallFee2 - overallFee3;
    // idem site-level: feeQ (overallTotalFee) bukan potongan saldo -> jangan dikurangi saat cek match.
    // STATUS_MATCH: _ostatus dihitung SETELAH _overallRow (butuh saldoAkhir final).

    // Grafik (nominal terbayar by paidAt, per HARI WIB). Selalu cakup seluruh rentang, <=31 batang.
    const totalDaysWib = Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;
    const MAX_BARS = 31;
    const chartBucketDays = Math.max(1, Math.ceil(totalDaysWib / MAX_BARS));
    const barCount = Math.max(1, Math.ceil(totalDaysWib / chartBucketDays));
    const buckets: Array<{ start: Date; end: Date }> = [];
    for (let i = 0; i < barCount; i++) {
      const bStart = new Date(from.getTime() + i * chartBucketDays * 86400000);
      const bEndMs = Math.min(bStart.getTime() + chartBucketDays * 86400000 - 1, to.getTime());
      buckets.push({ start: bStart, end: new Date(bEndMs) });
    }
    const bucketResults = await Promise.all(
      buckets.map(async (bk) => {
        const [cnt, agg] = await Promise.all([
          db.transaction.count({ where: withAccount({ statusPay: 'paid', paidAt: { gte: bk.start, lte: bk.end } }) }),
          db.transaction.aggregate({
            where: withAccount({ statusPay: 'paid', paidAt: { gte: bk.start, lte: bk.end } }),
            _sum: { finalAmount: true },
          }),
        ]);
        return { label: wibDayLabel(bk.start), count: cnt, amount: agg._sum.finalAmount ?? 0 };
      }),
    );
    const chartLabels = bucketResults.map((r) => r.label);
    const chartCounts = bucketResults.map((r) => r.count);
    const chartAmounts = bucketResults.map((r) => r.amount);

    const _pendingAgg = await pendingMoneyTotal(from, to, overallAccIds);
    const _overallModal = _modalFor(overallAccIds);
    // Alias-tenant: baris TOTAL "Semua Site" = hitung SITE mereka sendiri (bukan overall global) →
    // scope jangkar/anchor/status pakai 'site:<alias>', biar saldo awal/akhir tak bocor angka semua-site.
    // Master & bawah-master tetap 'overall'.
    const _overallScope = _aliasScope ? ('site:' + _aliasScope) : 'overall';
    const _overallRow = _resolveReportRow(_overallScope, { nominal: overallTotalPaid - _crossDay.total, pending: _pendingAgg.total, fee: overallTotalFee, fee2: overallFee2, fee3: overallFee3, bunga: overallBunga, modalMasuk: _overallModal, pencairan: _osb.pencairan, walkbackAwal: _osb.awal - _overallModal });
    const _ostatus = (getStatusOverride(_overallScope, _awalDate) ?? getStatusOverride('*', _awalDate)) ?? _statusFor(_overallRow, overallAccIds);
    // ONBOARDING mini-rows: 1 baris per akun baru (createdAt=hari ini) di antara SITE & TOTAL. Saldo Awal=0,
    // Modal Masuk=saldo saat ditambah, Saldo Akhir=fisik. Sudah IKUT di TOTAL via _overallModal -> Grand Total match.
    const _newRowIds = _isSingleDay ? overallAccIds.filter((id) => _newAccIds.has(id)) : [];
    const newAccountRows = await Promise.all(_newRowIds.map(async (id) => {
      const _pa = await db.transaction.aggregate({ where: { qrisAccountId: id, statusPay: 'paid', paidAt: { gte: from, lte: to } }, _sum: { finalAmount: true } });
      const _nom = _pa._sum.finalAmount ?? 0;
      const _pnd = (await pendingMoneyTotal(from, to, [id])).total;
      // Koreksi manual Fee/Fee2 per AKUN-BARU (mis. biaya layanan yg tak terekam mutasi) + note.
      const _afa = getFeeAdjust('acct:' + id, _awalDate);
      const _fee = _afa && _afa.fee != null ? _afa.fee : (feeQrisByAcc[id] || 0);
      const _fee2 = _afa && _afa.fee2 != null ? _afa.fee2 : (feeUtamaByAcc[id] || 0);
      const _fee3 = feeMaderaByAcc[id] || 0, _bng = bungaMaderaByAcc[id] || 0;
      const _pcr = (_madOut[id] && _madOut[id].pencairan) || 0;
      const _modal = _modalOf(id); // saldo saat ditambah (dikunci), BUKAN walk-back
      // Saldo Akhir = FISIK (saldo nyata akun), sesuai model koko. Status = cek rumus vs fisik.
      // feeQ AUTO (biaya layanan) TIDAK memotong saldo (QRIS gross - memo reconcile). TAPI fee MANUAL
      // (koko set, mis. potongan pra-deposit yg tak jadi mutasi) memang memotong -> ikut dikurangi.
      const _physAkhir = _asofAcc(id, 'akhir');
      const _manualFee = (_afa && _afa.fee != null) ? _afa.fee : 0;
      const _formulaAkhir = _nom + _pnd - _manualFee - _fee2 - _fee3 + _bng + _modal - _pcr;
      const _tolAkhir = Math.max(50000, Math.round(Math.abs(_physAkhir) * 0.01));
      const _stAkhir: 'match' | 'unmatch' = Math.abs(_formulaAkhir - _physAkhir) <= _tolAkhir ? 'match' : 'unmatch';
      return { accountName: _codeMap[id] || id, siteKey: accSiteMap[id] || 'none', saldoAwal: 0, modalMasuk: _modal, totalPaid: _nom, pending: _pnd, totalFee: _fee, feeNote: (_afa && _afa.feeNote) || null, fee2: _fee2, fee2Note: (_afa && _afa.fee2Note) || null, fee3: _fee3, bunga: _bng, pencairan: _pcr, saldoAkhir: _physAkhir, formulaAkhir: _formulaAkhir, status: _stAkhir, accountId: id };
    }));
    // Auto-carry (buku berjalan): Saldo Akhir hari LAMPAU (sudah tutup) -> Saldo Awal besok.
    // Set bila anchor besok NULL (baru) ATAU AUTO (carry lama -> REFRESH saat close hari ini dikoreksi).
    // Anchor MANUAL master + baseline DILINDUNGI (tak ditimpa). Fix bug jangkar basi tak update.
    if (_isSingleDay && to.getTime() < Date.now()) {
      bucketsToShow.forEach((b, i) => {
        const r = siteBreakdown[i] as { saldoAkhir?: number } | undefined;
        const _sc = 'site:' + b.key;
        if (r && !getBaseline(_sc, _akhirDate) && (getOpeningAnchor(_sc, _akhirDate) == null || isAutoAnchor(_sc, _akhirDate)))
          setOpeningAnchorAuto(_sc, _akhirDate, Number(r.saldoAkhir || 0) + newAccountRows.filter((nr) => nr.siteKey === b.key).reduce((sm, nr) => sm + nr.saldoAkhir, 0));
      });
      if (!_aliasScope && !getBaseline('overall', _akhirDate) && (getOpeningAnchor('overall', _akhirDate) == null || isAutoAnchor('overall', _akhirDate)))
        setOpeningAnchorAuto('overall', _akhirDate, _overallRow.saldoAkhir);
    }
    res.render('reports/index', {
      title: 'Laporan',
      isMaster: isMasterUser(req.session.user),
      anchorAwalDate: _awalDate,
      isSingleDay: _isSingleDay,
      range,
      from,
      to,
      fromStr: req.query.from ?? '',
      toStr: req.query.to ?? '',
      sites,
      selectedSite,
      siteLocked: !!_aliasScope,
      hasNoneBucket,
      siteBreakdown,
      newAccountRows,
      overall: {
        total: totalAll,
        paid: paidAll,
        expired: expiredAll,
        open: openAll,
        depositSuccess: depSuccessAll,
        depositFailed: depFailedAll,
        manualReview: manualReviewAll,
        totalPaid: _overallRow.nominal,
        pending: _overallRow.pending,
        totalFee: _overallRow.fee,
        fee2: _overallRow.fee2,
        fee3: _overallRow.fee3,
        bunga: overallBunga,
        modalMasuk: _overallRow.modalMasuk,
        saldoAwal: _overallRow.saldoAwal,
        saldoAkhir: _overallRow.saldoAkhir,
        saldoAwalManual: _overallRow.manual,
        saldoAkhirManual: _overallRow.isBaseline,
        pendingCarryProcessed: _overallRow.isBaseline ? 0 : _crossDay.total,
        pencairan: _overallRow.pencairan,
        pencairanManual: _overallRow.pencairanManual,
        fee3Manual: _overallRow.fee3Manual,
        netAmount: _onet,
        status: _ostatus,
        pendingTotal: _pendingAgg.total,
        pendingCount: _pendingAgg.count,
      },
      chartBucketDays,
      chartData: {
        labels: JSON.stringify(chartLabels),
        counts: JSON.stringify(chartCounts),
        amounts: JSON.stringify(chartAmounts),
      },
    });
    });
  } catch (err) {
    logger.error({ err }, 'showReports error');
    res.status(500).render('error/500', { title: 'Error' });
  }
}

/**
 * GET /api/v1/reports/summary — JSON API dengan rentang tanggal + optional clientId.
 */
// REPORT_ANCHOR_8: set jangkar saldo awal (master saja). scope 'overall' | 'site:<id>'.
export async function setOpeningBalanceApi(req: Request, res: Response): Promise<void> {
  try {
    if (!isMasterUser(req.session.user)) { res.status(403).json({ ok: false, message: 'Hanya master.' }); return; }
    const scope = typeof req.body?.scope === 'string' && req.body.scope ? req.body.scope : 'overall';
    const wibDate = String(req.body?.wibDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(wibDate)) { res.status(400).json({ ok: false, message: 'Tanggal WIB tidak valid (YYYY-MM-DD).' }); return; }
    const raw = req.body?.value;
    const value = (raw === null || raw === undefined || raw === '') ? null : Number(String(raw).replace(/[^0-9-]/g, ''));
    setOpeningAnchor(scope, wibDate, value);
    logger.info({ scope, wibDate, value }, 'reports: set jangkar saldo awal');
    res.json({ ok: true, scope, wibDate, value, anchors: listOpeningAnchors() });
  } catch (err) {
    logger.error({ err }, 'setOpeningBalanceApi error');
    res.status(500).json({ ok: false, message: 'Gagal simpan.' });
  }
}

// MODAL akun baru (master saja): set/koreksi saldo saat akun ditambah. Kosong = hapus (kembali auto-capture).
export async function setAccountModalApi(req: Request, res: Response): Promise<void> {
  try {
    if (!isMasterUser(req.session.user)) { res.status(403).json({ ok: false, message: 'Hanya master.' }); return; }
    const accountId = String(req.body?.accountId || '');
    if (!accountId) { res.status(400).json({ ok: false, message: 'accountId wajib.' }); return; }
    const raw = req.body?.value;
    const value = (raw === null || raw === undefined || raw === '') ? null : Number(String(raw).replace(/[^0-9-]/g, ''));
    if (value !== null && !Number.isFinite(value)) { res.status(400).json({ ok: false, message: 'Nilai modal tidak valid.' }); return; }
    setAccountModal(accountId, value);
    logger.info({ accountId, value }, 'reports: set modal akun baru');
    res.json({ ok: true, accountId, value });
  } catch (err) {
    logger.error({ err }, 'setAccountModalApi error');
    res.status(500).json({ ok: false, message: 'Gagal simpan.' });
  }
}

export async function setMaderaCorrectionApi(req: Request, res: Response): Promise<void> {
  try {
    if (!isMasterUser(req.session.user)) { res.status(403).json({ ok: false, message: 'Hanya master.' }); return; }
    const scope = typeof req.body?.scope === 'string' && req.body.scope ? req.body.scope : 'overall';
    const wibDate = String(req.body?.wibDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(wibDate)) { res.status(400).json({ ok: false, message: 'Tanggal WIB tidak valid (YYYY-MM-DD).' }); return; }
    const _num = (v: unknown): number | null => {
      const t = String(v ?? '').replace(/[^0-9]/g, '');
      return t === '' ? null : Number(t);
    };
    const pencairan = _num(req.body?.pencairan);
    const fee3 = _num(req.body?.fee3);
    if (pencairan !== null && (!Number.isFinite(pencairan) || pencairan < 0)) { res.status(400).json({ ok: false, message: 'Pencairan tidak valid.' }); return; }
    if (fee3 !== null && (!Number.isFinite(fee3) || fee3 < 0)) { res.status(400).json({ ok: false, message: 'Biaya transfer tidak valid.' }); return; }
    setPencairanOverride(scope, wibDate, pencairan);
    setFee3Override(scope, wibDate, fee3);
    logger.info({ scope, wibDate, pencairan, fee3 }, 'reports: set koreksi madera');
    res.json({ ok: true, scope, wibDate, pencairan, fee3 });
  } catch (err) {
    logger.error({ err }, 'setMaderaCorrectionApi error');
    res.status(500).json({ ok: false, message: 'Gagal simpan.' });
  }
}

export async function getReportsSummary(req: Request, res: Response): Promise<void> {
  try {
    const today = new Date();
    const defaultFrom = startOfDayWib(today);
    const defaultTo = endOfDayWib(today);
    const from = req.query.from ? startOfDayWib(new Date(req.query.from as string)) : defaultFrom;
    const to = req.query.to ? endOfDayWib(new Date(req.query.to as string)) : defaultTo;
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      res.status(400).json({ success: false, error: 'Parameter from/to tidak valid' });
      return;
    }
    const where: Record<string, unknown> = { createdAt: { gte: from, lte: to } };
    if (req.query.clientId) where.clientId = req.query.clientId;
    // FIX #2: uang by paidAt (pemasukan periode), bukan createdAt.
    const paidMoneyWhere: Record<string, unknown> = { statusPay: 'paid', paidAt: { gte: from, lte: to } };
    if (req.query.clientId) paidMoneyWhere.clientId = req.query.clientId;

    const [totalCount, paidCount, expiredCount, openCount] = await Promise.all([
      db.transaction.count({ where }),
      db.transaction.count({ where: { ...where, statusPay: 'paid' } }),
      db.transaction.count({ where: { ...where, statusPay: 'expired' } }),
      db.transaction.count({ where: { ...where, statusPay: 'open' } }),
    ]);
    const paidAggregate = await db.transaction.aggregate({
      where: paidMoneyWhere,
      _sum: { finalAmount: true, feeAmount: true },
    });
    const [depositSuccess, depositFailed, manualReview] = await Promise.all([
      db.transaction.count({ where: { ...where, statusBot: 'deposit_success' } }),
      db.transaction.count({ where: { ...where, statusBot: 'deposit_failed' } }),
      db.transaction.count({ where: { ...where, statusBot: 'manual_review' } }),
    ]);

    let perClient: Array<{
      clientId: string;
      clientName: string;
      panelCode: string;
      total: number;
      paid: number;
      totalPaid: number;
      totalFee: number;
    }> = [];

    if (!req.query.clientId) {
      const clients = await db.client.findMany({ select: { id: true, name: true, panelCode: true } });
      perClient = await Promise.all(
        clients.map(async (client) => {
          const cWhere = { ...where, clientId: client.id };
          const [cnt, paidCnt, agg] = await Promise.all([
            db.transaction.count({ where: cWhere }),
            db.transaction.count({ where: { ...cWhere, statusPay: 'paid' } }),
            db.transaction.aggregate({
              where: { clientId: client.id, statusPay: 'paid', paidAt: { gte: from, lte: to } },
              _sum: { finalAmount: true, feeAmount: true },
            }),
          ]);
          return {
            clientId: client.id,
            clientName: client.name,
            panelCode: client.panelCode,
            total: cnt,
            paid: paidCnt,
            totalPaid: agg._sum.finalAmount ?? 0,
            totalFee: agg._sum.feeAmount ?? 0,
          };
        }),
      );
    }

    res.json({
      success: true,
      data: {
        period: { from: from.toISOString(), to: to.toISOString() },
        transactions: { total: totalCount, paid: paidCount, expired: expiredCount, open: openCount },
        amounts: {
          totalPaid: paidAggregate._sum.finalAmount ?? 0,
          totalFee: paidAggregate._sum.feeAmount ?? 0,
          netAmount: (paidAggregate._sum.finalAmount ?? 0) - (paidAggregate._sum.feeAmount ?? 0),
        },
        deposits: { success: depositSuccess, failed: depositFailed, manualReview },
        perClient,
      },
    });
  } catch (err) {
    logger.error({ err }, 'getReportsSummary error');
    res.status(500).json({ success: false, error: 'Terjadi kesalahan internal' });
  }
}
