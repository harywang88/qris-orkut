/* Export mutasi -> CSV / Excel (.xlsx). Dipakai Mutasi QRIS/Utama/Madera.
   mutExport(fmt, kind, rows, filenameBase, sheetName)
   - fmt: 'csv' | 'xlsx'
   - kind: 'qris' | 'utama' (utama dipakai juga utk madera)
   - rows: array baris terfilter (yang sedang tampil)
   SheetJS (xlsx.full.min.js) di-load dari /js/ HANYA saat tombol Excel diklik. */
(function () {
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtT(t) {
    if (!t) return '';
    var d = (t instanceof Date) ? t : new Date(t);
    if (isNaN(d.getTime())) return String(t);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function scode(r) { return (r.statusCode || (r.type === 'credit' ? 'IN' : 'OUT')); }

  // Tiap kolom: [header, ambilNilai(r), isNumber?]
  var PRESETS = {
    qris: [
      ['Waktu', function (r) { return r.displayTime || fmtT(r.time); }],
      ['Akun', function (r) { return r.accountCode || ''; }],
      ['Merchant', function (r) { return r.merchant || ''; }],
      ['Site', function (r) { return r.siteName || ''; }],
      ['Tipe', function (r) { return scode(r) === 'IN' ? 'MASUK' : 'KELUAR'; }],
      ['Nominal', function (r) { return Number(r.amount || 0); }, true],
      ['Saldo', function (r) { return Number(r.balanceAfter || 0); }, true],
      ['Pengirim', function (r) { return r.senderName || ''; }],
      ['Bank/E-Wallet', function (r) { return r.bankEwallet || ''; }],
      ['RRN', function (r) { return r.rrn || ''; }],
      ['User ID', function (r) { return r.userIdExt || ''; }],
      ['Keterangan', function (r) { return r.description || ''; }],
      ['Status', function (r) { return r.matched ? 'MATCH' : 'PENDING'; }],
    ],
    utama: [
      ['Waktu', function (r) { return fmtT(r._time || r.time); }],
      ['Akun', function (r) { return r.accountCode || ''; }],
      ['Merchant', function (r) { return r.merchant || ''; }],
      ['Site', function (r) { return r.siteName || ''; }],
      ['Tipe', function (r) { return r.type === 'credit' ? 'MASUK' : 'KELUAR'; }],
      ['Nominal', function (r) { return Number(r.amount || 0); }, true],
      ['Biaya', function (r) { return Number(r._fee || r._fee3 || 0); }, true],
      ['RRN/Ref', function (r) { return r.rrn || r.refId || ''; }],
      ['Keterangan', function (r) { return r._desc || ''; }],
    ],
  };

  function csvEsc(s) {
    s = (s == null ? '' : String(s));
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  var _xlsxP = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    if (_xlsxP) return _xlsxP;
    _xlsxP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = '/js/xlsx.full.min.js';
      s.onload = function () { res(); };
      s.onerror = function () { _xlsxP = null; rej(new Error('gagal muat lib Excel')); };
      document.head.appendChild(s);
    });
    return _xlsxP;
  }

  window.mutExport = function (fmt, kind, rows, filenameBase, sheetName) {
    var cols = PRESETS[kind] || PRESETS.qris;
    rows = rows || [];
    if (!rows.length) { alert('Tidak ada data untuk di-export (cek filter/tanggal).'); return; }
    var fname = (filenameBase || 'mutasi') + '-' + fmtT(new Date()).slice(0, 10);

    if (fmt === 'csv') {
      var head = cols.map(function (c) { return csvEsc(c[0]); }).join(',');
      var body = rows.map(function (r) {
        return cols.map(function (c) { return csvEsc(c[1](r)); }).join(',');
      }).join('\r\n');
      // BOM supaya Excel baca UTF-8 (nama Indonesia dgn karakter khusus tetap benar)
      downloadBlob(new Blob(['﻿' + head + '\r\n' + body], { type: 'text/csv;charset=utf-8;' }), fname + '.csv');
      return;
    }

    // xlsx
    loadXlsx().then(function () {
      var aoa = [cols.map(function (c) { return c[0]; })];
      rows.forEach(function (r) {
        aoa.push(cols.map(function (c) {
          var v = c[1](r);
          return c[2] ? Number(v || 0) : v; // kolom angka jadi angka asli di Excel
        }));
      });
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, (sheetName || 'Mutasi').slice(0, 31));
      XLSX.writeFile(wb, fname + '.xlsx');
    }).catch(function (e) { alert('Gagal export Excel: ' + (e && e.message || e)); });
  };
})();
