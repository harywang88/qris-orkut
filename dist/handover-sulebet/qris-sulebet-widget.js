/**
 * ============================================================================
 *  QRIS KITA — Widget SULEBET (gaya alfael, 1 file, pakai ?key=)
 * ============================================================================
 *
 *  Meniru script alfaelpay: langsung panggil QRIS Kita dengan widget key di URL
 *  (tanpa proxy PHP). Key ini LOW-PRIVILEGE — hanya bisa membuat QR & membaca
 *  status QR miliknya sendiri, dan dikunci lewat allowlist Origin di server.
 *
 *  PASANG di footer template sulebet:
 *    <script src="/qris-sulebet-widget.js"></script>
 *
 *  Kredit saldo tetap lewat callback server-to-server (depositApiUrl ->
 *  deposit-callback.php). Setelah lunas, halaman di-reload.
 * ============================================================================
 */
(function () {
    'use strict';

    if (window.QrisKitaWidgetInit) return;
    window.QrisKitaWidgetInit = true;

    var CONFIG = {
        // Base URL QRIS Kita (termasuk APP_BASE_PATH). TANPA trailing slash.
        // APP_BASE_PATH server kosong -> route langsung di /widget, TANPA /qris.
        baseUrl: 'https://sayang.harywang.online',

        // Widget key dari dashboard > Clients (diawali "wk_"). Aman di browser.
        key: 'wk_sulebet_6a04daf467ccf6b58f1225d63502e5a5c0cf71b04cf09561',

        min: 10000,
        max: 10000000,
        buttonText: 'QRIS QuickPay',
        whitelist: [],           // [] = semua user; ['harywang'] utk batasi
        pollIntervalMs: 3000
    };

    // ── Deteksi username (pola PAY4D alfael) ──────────────────────────────────
    var usernameSelectors = [
        '.mb-lobby-username', '.user-login', '#current-user', '.username',
        '.user-name', '.player-name', '.member-name', '[data-username]',
        '.navbar-username', '.header-username', '.profile-username',
        '.account-name', '.navbar-right li a strong', '.navbar-nav li a strong',
        'nav li a strong'
    ];

    function detectUsername() {
        var s = document.querySelector('a[href*="toMyAccount"] strong') ||
                document.querySelector('a[href*="toMyAccount"]');
        if (s) { var t = s.textContent.trim(); if (t && t.length > 1 && t.length < 50) return t; }
        try {
            var spans = document.querySelectorAll('span[style*="font-weight:bold"], span[style*="font-weight: bold"]');
            for (var i = 0; i < spans.length; i++) {
                var st = spans[i].textContent.trim();
                if (st && st.length > 1 && st.length < 30) {
                    var p = spans[i].parentElement;
                    if (p && (p.textContent.indexOf(st + ' |') !== -1 || p.textContent.indexOf('| ' + st) !== -1)) return st;
                }
            }
        } catch (e) {}
        for (var j = 0; j < usernameSelectors.length; j++) {
            var el = document.querySelector(usernameSelectors[j]);
            if (el) {
                var text = (el.innerText || el.textContent || el.getAttribute('data-username') || '').trim();
                if (text && text.length < 50 && text.indexOf('IDR') === -1) return text.split('IDR')[0].trim();
            }
        }
        try {
            var body = document.body ? (document.body.innerText || '') : '';
            var m = body.match(/(\w{3,20})\s*\|\s*\1/);
            if (m) return m[1];
        } catch (e) {}
        return null;
    }

    function isWhitelisted(u) {
        if (!CONFIG.whitelist || CONFIG.whitelist.length === 0) return true;
        if (!u) return false;
        return CONFIG.whitelist.indexOf(String(u).toLowerCase()) !== -1;
    }

    // ── Sisip tab PAY4D ───────────────────────────────────────────────────────
    function createPay4dTab() {
        var navTabs = document.getElementById('depo-nav-pills') ||
                      document.getElementById('depo-nav-pills-m') ||
                      document.querySelector('.nav-pills, .nav-tabs, ul.nav');
        if (!navTabs) return false;
        var existingTab = navTabs.querySelector('li');
        if (!existingTab) return false;
        if (document.getElementById('qp-tab')) return true;

        var tabContent = null, sib = navTabs.nextElementSibling;
        while (sib) { if (sib.classList && sib.classList.contains('tab-content')) { tabContent = sib; break; } sib = sib.nextElementSibling; }
        if (!tabContent) tabContent = document.querySelector('.tab-content');

        var newTab = document.createElement('li');
        newTab.id = 'qp-tab';
        if (existingTab.className) newTab.className = existingTab.className.replace(/\bactive\b/g, '').trim();
        var tabLink = document.createElement('a');
        tabLink.href = '#qp-pane';
        tabLink.setAttribute('data-toggle', 'tab');
        tabLink.innerHTML = '<strong>' + CONFIG.buttonText + '</strong>';
        var exLink = existingTab.querySelector('a');
        if (exLink && exLink.className) tabLink.className = exLink.className.replace(/\bactive\b/g, '').trim();
        newTab.appendChild(tabLink);
        navTabs.appendChild(newTab);

        if (tabContent) {
            var pane = document.createElement('div');
            pane.id = 'qp-pane';
            pane.className = 'tab-pane fade';
            pane.style.display = 'none';
            pane.innerHTML =
                '<form class="form-group-sm" id="qp-form">' +
                '<div class="well well-sm" style="margin-top:10px;"><div>Deposit via <strong>' + CONFIG.buttonText + '</strong>. Scan QR Code menggunakan e-wallet atau mobile banking Anda.</div></div>' +
                '<div class="form-group"><label>Jumlah</label>' +
                '<input type="text" class="form-control text-right" id="qp-amount" style="font-weight:bold" placeholder="Masukkan jumlah deposit" onkeyup="var v=this.value.replace(/[^0-9]/g,\'\');this.value=v.replace(/\\B(?=(\\d{3})+(?!\\d))/g,\',\')"></div>' +
                '<input type="button" class="btn btn-info btn-block" id="qp-submit" value="Lanjutkan Pembayaran QRIS"></form>' +
                '<div id="qp-result" style="display:none;width:100%;margin-top:10px;"></div>';
            tabContent.appendChild(pane);
        }

        if (!document.getElementById('qris-quickpay-style')) {
            var style = document.createElement('style');
            style.id = 'qris-quickpay-style';
            style.innerHTML = '#qp-tab a{cursor:pointer}#qp-tab.active a{font-weight:bold}';
            document.head.appendChild(style);
        }

        tabLink.addEventListener('click', function (e) {
            e.preventDefault();
            if (tabContent) tabContent.querySelectorAll('.tab-pane:not(#qp-pane)').forEach(function (p) { p.setAttribute('data-qp-classes', p.className); p.style.display = 'none'; });
            navTabs.querySelectorAll('li').forEach(function (li) { li.classList.remove('active'); });
            newTab.classList.add('active');
            var qp = document.getElementById('qp-pane');
            if (qp) { qp.className = 'tab-pane fade active in'; qp.style.display = 'block'; }
        });

        navTabs.querySelectorAll('li:not(#qp-tab)').forEach(function (li) {
            li.addEventListener('click', function () {
                var qp = document.getElementById('qp-pane');
                if (qp) { qp.style.display = 'none'; qp.className = 'tab-pane fade'; }
                newTab.classList.remove('active');
                var f = document.getElementById('qp-form'), c = document.getElementById('qp-result');
                if (f) f.style.display = 'block';
                if (c) { c.style.display = 'none'; c.innerHTML = ''; }
                if (tabContent) tabContent.querySelectorAll('.tab-pane:not(#qp-pane)').forEach(function (p) {
                    var sv = p.getAttribute('data-qp-classes');
                    if (sv) { p.className = sv; p.removeAttribute('data-qp-classes'); }
                    p.style.display = '';
                });
            });
        });

        wireSubmit();
        console.log('QRIS Kita widget: tab dibuat');
        return true;
    }

    function wireSubmit() {
        var checkInterval = null, timerInterval = null;
        setTimeout(function () {
            var submitBtn = document.getElementById('qp-submit');
            if (!submitBtn) return;
            submitBtn.addEventListener('click', function () {
                var ai = document.getElementById('qp-amount');
                var amount = ai ? ai.value.replace(/,/g, '') : '0';
                if (!amount || parseInt(amount, 10) < CONFIG.min) { alert('Minimum deposit: Rp ' + CONFIG.min.toLocaleString('id-ID')); return; }
                if (parseInt(amount, 10) > CONFIG.max) { alert('Maximum deposit: Rp ' + CONFIG.max.toLocaleString('id-ID')); return; }

                var username = detectUsername() || 'guest';
                submitBtn.disabled = true; submitBtn.value = 'Memproses...';

                // Panggilan langsung gaya alfael: ?key=...&amount=...&member=...
                var url = CONFIG.baseUrl + '/widget/generate?key=' + encodeURIComponent(CONFIG.key) +
                          '&amount=' + encodeURIComponent(amount) +
                          '&member=' + encodeURIComponent(username);

                fetch(url).then(function (r) { return r.json(); }).then(function (resp) {
                    submitBtn.disabled = false; submitBtn.value = 'Lanjutkan Pembayaran QRIS';
                    if (!resp || !resp.success || !resp.data) { alert((resp && resp.error) || 'Gagal generate QR'); return; }
                    var d = resp.data;

                    var f = document.getElementById('qp-form'), c = document.getElementById('qp-result');
                    if (f) f.style.display = 'none';
                    var imgSrc = d.qrImageBase64 ? (d.qrImageBase64.indexOf('data:') === 0 ? d.qrImageBase64 : 'data:image/png;base64,' + d.qrImageBase64) : '';
                    var fmtAmt = 'Rp ' + parseInt(d.finalAmount, 10).toLocaleString('id-ID');
                    var expiredAt = new Date(d.expiresAt).getTime();
                    var qrId = d.qrId;

                    c.style.display = 'block';
                    c.innerHTML =
                        '<div class="text-center">' +
                        '<div class="well well-sm" style="margin-top:10px;margin-bottom:15px;"><strong>Scan QR Code menggunakan e-wallet atau mobile banking</strong></div>' +
                        '<div style="background:#fff;border-radius:8px;padding:12px;display:inline-block;margin-bottom:15px;"><img id="qris-qr-img" src="' + imgSrc + '" style="width:220px;height:220px;" alt="QR Code"></div>' +
                        '<div style="font-size:24px;font-weight:bold;margin:10px 0;">' + fmtAmt + '</div>' +
                        '<div style="font-size:11px;color:#999;margin-bottom:5px;">Kode Unik: ' + (d.uniqueCode != null ? d.uniqueCode : '-') + '</div>' +
                        '<div style="font-size:13px;margin-bottom:15px;word-break:break-all;">' + qrId + '</div>' +
                        '<div id="qris-timer" style="font-size:22px;font-weight:bold;color:#f0ad4e;margin:10px 0;"></div>' +
                        '<div id="qris-status" style="font-size:13px;color:#999;margin-bottom:15px;">Menunggu pembayaran...</div>' +
                        '<div style="display:flex;gap:8px;max-width:320px;margin:0 auto;">' +
                        '<button type="button" id="qris-dl-btn" class="btn btn-info btn-block" style="flex:1;">Download QR</button>' +
                        '<button type="button" id="qris-back-btn" class="btn btn-default btn-block" style="flex:1;">Kembali</button>' +
                        '</div></div>';
                    c.scrollIntoView({ behavior: 'smooth', block: 'start' });

                    document.getElementById('qris-dl-btn').addEventListener('click', function () {
                        var a = document.createElement('a'); a.href = imgSrc; a.download = 'QRIS_' + qrId + '.png';
                        document.body.appendChild(a); a.click(); document.body.removeChild(a);
                    });
                    document.getElementById('qris-back-btn').addEventListener('click', function () {
                        if (checkInterval) clearInterval(checkInterval);
                        if (timerInterval) clearInterval(timerInterval);
                        c.style.display = 'none'; c.innerHTML = '';
                        if (f) f.style.display = 'block';
                    });

                    timerInterval = setInterval(function () {
                        var diff = expiredAt - new Date().getTime();
                        var te = document.getElementById('qris-timer');
                        if (!te) { clearInterval(timerInterval); return; }
                        if (diff <= 0) {
                            te.textContent = 'EXPIRED'; te.style.color = '#ef4444';
                            var se = document.getElementById('qris-status'); if (se) se.textContent = 'QR Code sudah kadaluarsa';
                            clearInterval(timerInterval); if (checkInterval) clearInterval(checkInterval); return;
                        }
                        var mm = Math.floor(diff / 60000), ss = Math.floor((diff % 60000) / 1000);
                        te.textContent = String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
                    }, 1000);

                    checkInterval = setInterval(function () {
                        var su = CONFIG.baseUrl + '/widget/status?key=' + encodeURIComponent(CONFIG.key) +
                                 '&qrId=' + encodeURIComponent(qrId) + '&_t=' + new Date().getTime();
                        fetch(su).then(function (r) { return r.json(); }).then(function (s) {
                            var se = document.getElementById('qris-status');
                            if (!se) { clearInterval(checkInterval); return; }
                            if (!s || !s.success || !s.data) return;
                            var sp = String(s.data.statusPay || '').toLowerCase();
                            if (sp === 'paid' || sp === 'success' || sp === 'settled') {
                                clearInterval(checkInterval); clearInterval(timerInterval);
                                showSuccess(fmtAmt);
                            } else if (sp === 'expired' || sp === 'failed' || sp === 'cancelled') {
                                se.textContent = 'Pembayaran ' + sp + '.';
                            }
                        }).catch(function () {});
                    }, CONFIG.pollIntervalMs);
                }).catch(function (err) {
                    submitBtn.disabled = false; submitBtn.value = 'Lanjutkan Pembayaran QRIS';
                    alert('Error: ' + err.message);
                });
            });
        }, 500);
    }

    function showSuccess(amtText) {
        var r = document.getElementById('qp-result');
        if (!r) { window.location.reload(); return; }
        r.innerHTML =
            '<div style="text-align:center;padding:30px 15px;">' +
            '<div style="width:70px;height:70px;border-radius:50%;background:#22c55e;margin:0 auto 15px;display:flex;align-items:center;justify-content:center;">' +
            '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div>' +
            '<div style="font-size:20px;font-weight:700;color:#22c55e;margin-bottom:5px;">PEMBAYARAN BERHASIL!</div>' +
            '<div style="font-size:14px;color:#999;margin-bottom:15px;">Deposit sedang diproses ke akun Anda</div>' +
            '<div style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:8px;padding:12px;margin-bottom:20px;">' +
            '<div style="font-size:12px;color:#999;">TOTAL DIBAYAR</div>' +
            '<div style="font-size:24px;font-weight:700;color:#22c55e;">' + amtText + '</div></div>' +
            '<div style="font-size:13px;color:#888;">Halaman akan refresh dalam <span id="qp-countdown" style="color:#fbbf24;font-weight:700;">5</span> detik...</div></div>';
        var cd = 5, cdEl = document.getElementById('qp-countdown');
        var iv = setInterval(function () { cd--; if (cdEl) cdEl.textContent = cd; if (cd <= 0) { clearInterval(iv); window.location.reload(); } }, 1000);
    }

    function init() {
        var attempts = 0;
        function tryCreate() {
            var u = detectUsername();
            if (CONFIG.whitelist && CONFIG.whitelist.length > 0 && !isWhitelisted(u)) {
                if (++attempts >= 30) clearInterval(loop);
                return;
            }
            if (createPay4dTab()) clearInterval(loop);
            else if (++attempts >= 30) { clearInterval(loop); console.log('QRIS Kita widget: nav-tabs tidak ditemukan'); }
        }
        var loop = setInterval(tryCreate, 500);
        tryCreate();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else setTimeout(init, 100);
})();
