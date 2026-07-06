/**
 * Backfill site ke metadataJson tiap Transaction (dari akun -> site via site.service).
 * Idempoten. Default DRY-RUN; tambah argumen --apply untuk menulis.
 * Jalankan SETELAH akun di-assign ke site (kalau belum, semua -> siteName null).
 *   node backfill-tx-site.cjs           (dry-run)
 *   node backfill-tx-site.cjs --apply   (tulis)
 */
const { PrismaClient } = require('@prisma/client');
const svc = require('/opt/qris-orkut/dist/shared/site.service.js');
const db = new PrismaClient();
const APPLY = process.argv.includes('--apply');
(async () => {
  const resolve = svc.buildResolver();
  const txs = await db.transaction.findMany({ select: { id: true, qrisAccountId: true, metadataJson: true } });
  let changed = 0, withSite = 0;
  for (const t of txs) {
    const s = resolve(t.qrisAccountId);
    let meta = {};
    try { meta = t.metadataJson ? JSON.parse(t.metadataJson) : {}; } catch (_) { meta = {}; }
    const newMeta = Object.assign({}, meta, {
      siteId: s.siteId,
      siteName: s.siteName,
      site: s.siteName || (typeof meta.site === 'string' ? meta.site : '-'),
    });
    if (s.siteName) withSite++;
    if (JSON.stringify(newMeta) !== JSON.stringify(meta)) {
      changed++;
      if (APPLY) await db.transaction.update({ where: { id: t.id }, data: { metadataJson: JSON.stringify(newMeta) } });
    }
  }
  console.log((APPLY ? 'APPLIED' : 'DRY-RUN') + ': total=' + txs.length + ' akan-diubah=' + changed + ' punya-site=' + withSite);
  await db.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
