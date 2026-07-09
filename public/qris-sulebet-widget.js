/**
 * ============================================================================
 *  QRIS QuickPay — Widget SULEBET
 * ============================================================================
 *
 *  Script satu-file untuk memasang tab deposit "QRIS QuickPay" di halaman
 *  deposit sulebet. Memanggil endpoint publik QRIS Kita dengan widget key
 *  (?key=...) — key ini low-privilege: hanya bisa membuat QR & membaca status
 *  QR miliknya sendiri, dan dikunci lewat allowlist Origin di server.
 *
 *  PASANG (letakkan sebelum </body> pada template sulebet):
 *    <script src="/qris-sulebet-widget.js"></script>
 *
 *  Alur:
 *    1. Sisip tab "QRIS QuickPay" ke nav deposit yang ada.
 *    2. User isi jumlah -> GET /widget/generate -> tampil QR + timer.
 *    3. Polling GET /widget/status -> saat lunas, tampilkan sukses & reload.
 *
 *  Kredit saldo TIDAK lewat script ini (dilakukan server-side oleh worker
 *  auto-deposit yang login ke panel). Script hanya menampilkan QR & status.
 * ============================================================================
 */
(function () {
  'use strict';

  if (window.__qrisSulebetWidgetLoaded) return;
  window.__qrisSulebetWidgetLoaded = true;

  var CONFIG = {
    // Base URL QRIS Kita (tanpa trailing slash). APP_BASE_PATH server kosong,
    // jadi endpoint langsung di /widget (TANPA /qris).
    baseUrl: 'https://qriskitaoke.com',

    // Widget key sulebet (aman ditaruh di browser).
    key: 'wk_sulebet_6a04daf467ccf6b58f1225d63502e5a5c0cf71b04cf09561',

    minAmount: 10000,
    maxAmount: 10000000,
    tabLabel: 'QRIS QuickPay',
    pollIntervalMs: 3000,

    // Aktif/nonaktif cepat tanpa mencopot tag script. false = widget diam total.
    enabled: true,

    // Daftar username yang boleh MELIHAT tab (untuk uji bertahap saat situs live).
    // Kosong = tampil untuk SEMUA member.
    onlyUsers: [],
  };

  // ── Konfigurasi dari halaman sulebet (gaya AlfaelPay) ──────────────────────
  // Prioritas: window.QRIS_QUICKPAY_CONFIG (snippet inline) > atribut data-* pada
  // tag <script> > default di atas. Semua opsional; yang tidak diisi pakai default.
  (function readPageConfig() {
    function toUserList(v) {
      if (!v) return [];
      if (Object.prototype.toString.call(v) === '[object Array]') {
        return v.map(function (s) { return String(s).trim().toLowerCase(); }).filter(Boolean);
      }
      return String(v).split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    }

    // (1) atribut pada tag <script src=".../qris-sulebet-widget.js" ...>
    try {
      var cs = document.currentScript;
      if (!cs) {
        var ss = document.getElementsByTagName('script');
        for (var i = ss.length - 1; i >= 0; i--) {
          if (ss[i].src && ss[i].src.indexOf('qris-sulebet-widget.js') !== -1) { cs = ss[i]; break; }
        }
      }
      if (cs && cs.getAttribute) {
        var attrUsers = cs.getAttribute('data-only-users');
        if (attrUsers != null) CONFIG.onlyUsers = toUserList(attrUsers);
        if (cs.getAttribute('data-enabled') === 'false') CONFIG.enabled = false;
      }
    } catch (e) {}

    // (2) objek global window.QRIS_QUICKPAY_CONFIG (menimpa atribut)
    try {
      var g = window.QRIS_QUICKPAY_CONFIG;
      if (g && typeof g === 'object') {
        if (typeof g.enabled === 'boolean') CONFIG.enabled = g.enabled;
        // whitelist / onlyUsers: dukung dua nama supaya mirip AlfaelPay.
        if (g.whitelist != null) CONFIG.onlyUsers = toUserList(g.whitelist);
        else if (g.onlyUsers != null) CONFIG.onlyUsers = toUserList(g.onlyUsers);
        if (g.key) CONFIG.key = String(g.key);
        if (g.baseUrl) CONFIG.baseUrl = String(g.baseUrl).replace(/\/+$/, '');
        if (g.tabLabel) CONFIG.tabLabel = String(g.tabLabel);
        if (g.minAmount > 0) CONFIG.minAmount = parseInt(g.minAmount, 10);
        if (g.maxAmount > 0) CONFIG.maxAmount = parseInt(g.maxAmount, 10);
        if (g.pollIntervalMs > 0) CONFIG.pollIntervalMs = parseInt(g.pollIntervalMs, 10);
      }
    } catch (e) {}
  })();

  // ── util ──────────────────────────────────────────────────────────────────
  function rupiah(n) {
    return 'Rp ' + (parseInt(n, 10) || 0).toLocaleString('id-ID');
  }
  function el(tag, props) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) { e[k] = props[k]; });
    return e;
  }

  // ── deteksi username member dari DOM sulebet ───────────────────────────────
  var USERNAME_SELECTORS = [
    'a[href*="toMyAccount"] strong',
    'a[href*="toMyAccount"]',
    '.mb-lobby-username', '.navbar-username', '.header-username',
    '.profile-username', '.account-name', '.member-name', '.player-name',
    '.user-name', '.username', '[data-username]',
    '.navbar-right li a strong', '.navbar-nav li a strong', 'nav li a strong',
  ];

  function detectUsername() {
    for (var i = 0; i < USERNAME_SELECTORS.length; i++) {
      var node = document.querySelector(USERNAME_SELECTORS[i]);
      if (!node) continue;
      var raw = (node.getAttribute && node.getAttribute('data-username')) ||
                node.innerText || node.textContent || '';
      var text = String(raw).split('IDR')[0].split('|')[0].trim();
      if (text && text.length > 1 && text.length < 40) return text;
    }
    // DOM: header sulebet -> <span style="font-weight:bold">username</span>
    // diikuti <span> | Nama Lengkap</span>. Cari <span> bold yang tetangganya
    // mengandung "|". Ini pola paling andal untuk template sulebet mobile+desktop.
    try {
      var spans = document.querySelectorAll('span');
      for (var s = 0; s < spans.length; s++) {
        var sp = spans[s];
        var style = (sp.getAttribute && sp.getAttribute('style')) || '';
        if (!/font-weight\s*:\s*bold/i.test(style)) continue;
        var next = sp.nextElementSibling;
        var nextTxt = next ? (next.innerText || next.textContent || '') : '';
        if (nextTxt.indexOf('|') === -1) continue;
        var uname = String(sp.innerText || sp.textContent || '').trim();
        if (uname && /^[A-Za-z0-9_.]{3,30}$/.test(uname)) return uname;
      }
    } catch (e) {}

    // Teks: pola "username | Nama Lengkap" (username = token pertama, tanpa spasi).
    // Ambil token pertama sebelum '|' yang berupa username valid.
    try {
      var body = document.body ? (document.body.innerText || '') : '';
      // "username | nama" identik (fallback lama)
      var mid = body.match(/([A-Za-z0-9_]{3,20})\s*\|\s*\1/);
      if (mid) return mid[1];
      // "username | Nama Lengkap" (beda) -> ambil username-nya
      var m2 = body.match(/(?:^|\s)([A-Za-z0-9_.]{3,30})\s*\|\s+[A-Za-z]/);
      if (m2) return m2[1];
    } catch (e) {}
    return null;
  }

  // Cek apakah username saat ini termasuk yang diizinkan melihat tab.
  // onlyUsers kosong -> semua boleh. Ada isinya -> hanya yang cocok (case-insensitive).
  function isUserAllowed() {
    if (!CONFIG.onlyUsers || CONFIG.onlyUsers.length === 0) return true;
    var u = detectUsername();
    if (!u) return false; // gating aktif tapi user belum terdeteksi -> jangan tampilkan dulu
    return CONFIG.onlyUsers.indexOf(String(u).trim().toLowerCase()) !== -1;
  }

  // ── sisip tab QRIS QuickPay ────────────────────────────────────────────────
  function findNav() {
    return document.getElementById('depo-nav-pills') ||
           document.getElementById('depo-nav-pills-m') ||
           document.querySelector('.nav-pills, .nav-tabs, ul.nav');
  }

  function findTabContent(nav) {
    var sib = nav.nextElementSibling;
    while (sib) {
      if (sib.classList && sib.classList.contains('tab-content')) return sib;
      sib = sib.nextElementSibling;
    }
    return document.querySelector('.tab-content');
  }

  function injectTab() {
    var nav = findNav();
    if (!nav) return false;
    if (document.getElementById('qp-tab')) return true;
    // Gating username (uji bertahap): kalau tidak diizinkan, jangan sisip tab.
    // Return false supaya loop init tetap mencoba lagi (username mungkin baru
    // muncul di DOM beberapa saat kemudian). Setelah retry habis, tab tetap
    // tidak muncul untuk user yang tidak diizinkan.
    if (!isUserAllowed()) return false;

    var sampleLi = nav.querySelector('li');
    if (!sampleLi) return false;
    var sampleLink = sampleLi.querySelector('a');
    var tabContent = findTabContent(nav);

    // tab
    var li = el('li', { id: 'qp-tab' });
    if (sampleLi.className) li.className = sampleLi.className.replace(/\bactive\b/g, '').trim();
    var link = el('a');
    link.href = '#qp-pane';
    link.setAttribute('data-toggle', 'tab');
    link.innerHTML = '<strong>' + CONFIG.tabLabel + '</strong>';
    if (sampleLink && sampleLink.className) {
      link.className = sampleLink.className.replace(/\bactive\b/g, '').trim();
    }
    li.appendChild(link);
    nav.appendChild(li);

    // pane
    if (tabContent) {
      var pane = el('div', { id: 'qp-pane', className: 'tab-pane fade' });
      pane.style.display = 'none';
      pane.innerHTML =
        '<form id="qp-form" class="form-group-sm">' +
          '<div class="well well-sm" style="margin-top:10px;">Deposit via <strong>' + CONFIG.tabLabel + '</strong>. Scan QR menggunakan e-wallet atau mobile banking Anda.</div>' +
          '<div class="form-group"><label>Jumlah</label>' +
            '<input type="text" inputmode="numeric" class="form-control text-right" id="qp-amount" style="font-weight:bold" placeholder="Masukkan jumlah deposit">' +
          '</div>' +
          '<input type="button" class="btn btn-info btn-block" id="qp-submit" value="Lanjutkan Pembayaran QRIS">' +
        '</form>' +
        '<div id="qp-result" style="display:none;margin-top:10px;"></div>';
      tabContent.appendChild(pane);
    }

    injectStyle();
    wireTabToggling(nav, li, tabContent);
    wireAmountFormat();
    wireSubmit();
    return true;
  }

  function injectStyle() {
    if (document.getElementById('qp-style')) return;
    var s = el('style', { id: 'qp-style' });
    s.innerHTML = '#qp-tab a{cursor:pointer}#qp-tab.active a{font-weight:bold}';
    document.head.appendChild(s);
  }

  function wireTabToggling(nav, li, tabContent) {
    var link = li.querySelector('a');
    link.addEventListener('click', function (e) {
      e.preventDefault();
      if (tabContent) {
        tabContent.querySelectorAll('.tab-pane:not(#qp-pane)').forEach(function (p) {
          if (!p.getAttribute('data-qp-prev')) p.setAttribute('data-qp-prev', p.className);
          p.classList.remove('active', 'in');
          p.style.display = 'none';
        });
      }
      nav.querySelectorAll('li').forEach(function (x) { x.classList.remove('active'); });
      li.classList.add('active');
      var qp = document.getElementById('qp-pane');
      if (qp) { qp.className = 'tab-pane fade active in'; qp.style.display = 'block'; }
    });

    nav.querySelectorAll('li:not(#qp-tab)').forEach(function (other) {
      other.addEventListener('click', function () {
        var qp = document.getElementById('qp-pane');
        if (qp) { qp.className = 'tab-pane fade'; qp.style.display = 'none'; }
        li.classList.remove('active');
        resetForm();
        if (tabContent) {
          tabContent.querySelectorAll('.tab-pane:not(#qp-pane)').forEach(function (p) {
            var prev = p.getAttribute('data-qp-prev');
            if (prev != null) { p.className = prev; p.removeAttribute('data-qp-prev'); }
            p.style.display = '';
          });
        }
      });
    });
  }

  function wireAmountFormat() {
    var input = document.getElementById('qp-amount');
    if (!input) return;
    input.addEventListener('keyup', function () {
      var v = this.value.replace(/[^0-9]/g, '');
      this.value = v.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    });
  }

  function resetForm() {
    var f = document.getElementById('qp-form');
    var r = document.getElementById('qp-result');
    if (f) f.style.display = 'block';
    if (r) { r.style.display = 'none'; r.innerHTML = ''; }
    stopPolling();
  }

  // ── generate + polling ─────────────────────────────────────────────────────
  var checkTimer = null, countdownTimer = null;

  function stopPolling() {
    if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  function wireSubmit() {
    var btn = document.getElementById('qp-submit');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var amtInput = document.getElementById('qp-amount');
      var amount = amtInput ? amtInput.value.replace(/[^0-9]/g, '') : '';
      var n = parseInt(amount, 10);
      if (!n || n < CONFIG.minAmount) { alert('Minimum deposit: ' + rupiah(CONFIG.minAmount)); return; }
      if (n > CONFIG.maxAmount) { alert('Maksimum deposit: ' + rupiah(CONFIG.maxAmount)); return; }

      var member = detectUsername() || 'guest';
      btn.disabled = true;
      btn.value = 'Memproses...';

      var url = CONFIG.baseUrl + '/widget/generate' +
                '?key=' + encodeURIComponent(CONFIG.key) +
                '&amount=' + encodeURIComponent(amount) +
                '&member=' + encodeURIComponent(member);

      fetch(url)
        .then(function (r) { return r.json(); })
        .then(function (resp) {
          btn.disabled = false;
          btn.value = 'Lanjutkan Pembayaran QRIS';
          if (!resp || !resp.success || !resp.data) {
            alert((resp && resp.error) || 'Gagal membuat QR. Coba lagi.');
            return;
          }
          showQr(resp.data);
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.value = 'Lanjutkan Pembayaran QRIS';
          alert('Terjadi kesalahan jaringan: ' + err.message);
        });
    });
  }

  function showQr(d) {
    var form = document.getElementById('qp-form');
    var result = document.getElementById('qp-result');
    if (form) form.style.display = 'none';
    if (!result) return;

    var imgSrc = d.qrImageBase64
      ? (d.qrImageBase64.indexOf('data:') === 0 ? d.qrImageBase64 : 'data:image/png;base64,' + d.qrImageBase64)
      : '';
    var amtText = rupiah(d.finalAmount);
    var expiresAt = new Date(d.expiresAt).getTime();
    var qrId = d.qrId;

    result.style.display = 'block';
    result.innerHTML =
      '<div class="text-center">' +
        '<div class="well well-sm" style="margin-top:10px;margin-bottom:15px;"><strong>Scan QR Code menggunakan e-wallet atau mobile banking</strong></div>' +
        '<div style="background:#fff;border-radius:8px;padding:12px;display:inline-block;margin-bottom:10px;">' +
          '<img id="qp-qr-img" src="' + imgSrc + '" style="width:220px;height:220px;" alt="QR Code">' +
        '</div>' +
        '<div style="margin:0 auto 14px;max-width:300px;">' +
          '<div style="color:#f0871e;font-weight:700;font-size:13px;">QR ini hanya untuk <span style="text-decoration:underline">1 kali pembayaran</span></div>' +
          '<div style="color:#999;font-size:11px;margin-top:2px;">Jika terlanjur bayar 2 kali, hubungi CS</div>' +
        '</div>' +
        '<div style="font-size:24px;font-weight:bold;margin:10px 0;">' + amtText + '</div>' +
        (d.uniqueCode != null ? '<div style="font-size:11px;color:#999;margin-bottom:5px;">Kode Unik: ' + d.uniqueCode + '</div>' : '') +
        '<div style="font-size:12px;color:#888;margin-bottom:12px;word-break:break-all;">' + qrId + '</div>' +
        '<div id="qp-timer" style="font-size:22px;font-weight:bold;color:#f0ad4e;margin:10px 0;"></div>' +
        '<div id="qp-status" style="font-size:13px;color:#999;margin-bottom:15px;">Menunggu pembayaran...</div>' +
        '<div style="display:flex;gap:8px;max-width:320px;margin:0 auto;">' +
          '<button type="button" id="qp-dl" class="btn btn-info btn-block" style="flex:1;">Download QR</button>' +
          '<button type="button" id="qp-back" class="btn btn-default btn-block" style="flex:1;">Kembali</button>' +
        '</div>' +
      '</div>';
    try { result.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}

    document.getElementById('qp-dl').addEventListener('click', function () {
      if (!imgSrc) return;
      var a = el('a', { href: imgSrc, download: 'QRIS_' + qrId + '.png' });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    });
    document.getElementById('qp-back').addEventListener('click', resetForm);

    startCountdown(expiresAt);
    startPolling(qrId, amtText);
  }

  function startCountdown(expiresAt) {
    countdownTimer = setInterval(function () {
      var timerEl = document.getElementById('qp-timer');
      if (!timerEl) { stopPolling(); return; }
      var diff = expiresAt - new Date().getTime();
      if (diff <= 0) {
        timerEl.textContent = 'EXPIRED';
        timerEl.style.color = '#ef4444';
        var st = document.getElementById('qp-status');
        if (st) st.textContent = 'QR Code sudah kadaluarsa. Silakan buat baru.';
        stopPolling();
        return;
      }
      var mm = Math.floor(diff / 60000);
      var ss = Math.floor((diff % 60000) / 1000);
      timerEl.textContent = String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    }, 1000);
  }

  function startPolling(qrId, amtText) {
    checkTimer = setInterval(function () {
      var statusEl = document.getElementById('qp-status');
      if (!statusEl) { stopPolling(); return; }
      var url = CONFIG.baseUrl + '/widget/status' +
                '?key=' + encodeURIComponent(CONFIG.key) +
                '&qrId=' + encodeURIComponent(qrId) +
                '&_t=' + new Date().getTime();
      fetch(url)
        .then(function (r) { return r.json(); })
        .then(function (s) {
          if (!s || !s.success || !s.data) return;
          var sp = String(s.data.statusPay || '').toLowerCase();
          if (sp === 'paid' || sp === 'success' || sp === 'settled') {
            stopPolling();
            showSuccess(amtText);
          } else if (sp === 'expired' || sp === 'failed' || sp === 'cancelled') {
            statusEl.textContent = 'Pembayaran ' + sp + '.';
          }
        })
        .catch(function () {});
    }, CONFIG.pollIntervalMs);
  }

  function showSuccess(amtText) {
    var result = document.getElementById('qp-result');
    if (!result) { window.location.reload(); return; }
    result.innerHTML =
      '<div style="text-align:center;padding:30px 15px;">' +
        '<div style="width:70px;height:70px;border-radius:50%;background:#22c55e;margin:0 auto 15px;display:flex;align-items:center;justify-content:center;">' +
          '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' +
        '</div>' +
        '<div style="font-size:20px;font-weight:700;color:#22c55e;margin-bottom:5px;">PEMBAYARAN BERHASIL!</div>' +
        '<div style="font-size:14px;color:#999;margin-bottom:15px;">Deposit sedang diproses ke akun Anda</div>' +
        '<div style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:8px;padding:12px;margin-bottom:20px;">' +
          '<div style="font-size:12px;color:#999;">TOTAL DIBAYAR</div>' +
          '<div style="font-size:24px;font-weight:700;color:#22c55e;">' + amtText + '</div>' +
        '</div>' +
        '<div style="font-size:13px;color:#888;">Halaman akan refresh dalam <span id="qp-countdown" style="color:#fbbf24;font-weight:700;">5</span> detik...</div>' +
      '</div>';
    var cd = 5;
    var cdEl = document.getElementById('qp-countdown');
    var iv = setInterval(function () {
      cd--;
      if (cdEl) cdEl.textContent = cd;
      if (cd <= 0) { clearInterval(iv); window.location.reload(); }
    }, 1000);
  }

  // ── init: coba sisip tab sampai nav tersedia ───────────────────────────────
  function init() {
    if (!CONFIG.enabled) return; // dimatikan dari config -> diam total
    var attempts = 0;
    var loop = setInterval(function () {
      if (injectTab() || ++attempts >= 40) clearInterval(loop);
    }, 500);
    injectTab();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 100);
  }
})();
