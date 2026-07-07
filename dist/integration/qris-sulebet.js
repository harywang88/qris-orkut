/**
 * ============================================================================
 *  QRIS KITA — Embed untuk panel SULEBET (PAY4D)
 * ============================================================================
 *
 *  Meniru alur script alfaelpay, TAPI terkoneksi ke QRIS Kita lewat proxy PHP
 *  di server sulebet (qris-proxy.php). Secret HMAC TIDAK pernah ada di browser.
 *
 *  Yang dilakukan script ini (sama seperti alfael di sulebet):
 *   1. Auto-deteksi username dari DOM sulebet (tidak perlu user ketik).
 *   2. Menyisipkan tab "QRIS QuickPay" ke nav-pills deposit (#depo-nav-pills).
 *   3. Form jumlah -> generate QR lewat proxy -> tampil QR di #qp-result.
 *   4. Polling status tiap 3 detik -> saat "paid" tampil sukses -> RELOAD
 *      halaman (saldo sudah dikreditkan QRIS Kita via depositApiUrl).
 *
 *  PASANG (di footer template sulebet):
 *    <script src="/qris-sulebet.js"></script>
 * ============================================================================
 */
(function () {
    'use strict';

    if (window.QrisKitaInitialized) return;
    window.QrisKitaInitialized = true;

    var CONFIG = {
        // Proxy PHP di server sulebet (path relatif, bukan URL ke QRIS Kita).
        proxyUrl: '/qris-proxy.php',

        min: 10000,
        max: 10000000,

        buttonText: 'QRIS QuickPay',

        // Kosongkan [] = semua user. Isi ['harywang'] utk batasi (huruf kecil).
        whitelist: [],

        pollIntervalMs: 3000,
    };

    // ── Deteksi username (disalin dari pola alfael utk PAY4D/sulebet) ──────────
    var usernameSelectors = [
        '.mb-lobby-username', '.user-login', '#current-user', '.username',
        '.user-name', '.player-name', '.member-name', '[data-username]',
        '.navbar-username', '.header-username', '.profile-username',
        '.account-name', '.navbar-right li a strong', '.navbar-nav li a strong',
        'nav li a strong'
    ];

    function detectUsername() {
        var pay4dLink = document.querySelector('a[href*="toMyAccount"] strong');
        if (pay4dLink) {
            var utext = pay4dLink.textContent.trim();
            if (utext && utext.length > 1 && utext.length < 50) return utext;
        }
        var pay4dAnchor = document.querySelector('a[href*="toMyAccount"]');
        if (pay4dAnchor) {
            var atext = pay4dAnchor.textContent.trim();
            if (atext && atext.length > 1 && atext.length < 50) return atext;
        }
        try {
            var allSpans = document.querySelectorAll('span[style*="font-weight:bold"], span[style*="font-weight: bold"]');
            for (var si = 0; si < allSpans.length; si++) {
                var spanText = allSpans[si].textContent.trim();
                if (spanText && spanText.length > 1 && spanText.length < 30) {
                    var parent = allSpans[si].parentElement;
                    if (parent) {
                        var parentText = parent.textContent || '';
                        if (parentText.indexOf(spanText + ' |') !== -1 || parentText.indexOf('| ' + spanText) !== -1) {
                            return spanText;
                        }
                    }
                }
            }
        } catch (e) {}
        try {
            var navRight = document.querySelector('.navbar-right li a strong, .navbar-nav li a strong');
            if (navRight) {
                var ntext = navRight.textContent.trim();
                if (ntext && ntext.length > 1 && ntext.length < 50) return ntext;
            }
        } catch (e) {}
        for (var i = 0; i < usernameSelectors.length; i++) {
            var el = document.querySelector(usernameSelectors[i]);
            if (el) {
                var text = el.innerText || el.textContent || el.getAttribute('data-username') || '';
                text = text.trim();
                if (text && text.length > 0 && text.length < 50 && text.indexOf('IDR') === -1) {
                    return text.split('IDR')[0].trim();
                }
            }
        }
        try {
            var body = document.body ? (document.body.innerText || document.body.textContent || '') : '';
            var m = body.match(/(\w{3,20})\s*\|\s*\1/);
            if (m) return m[1];
        } catch (e) {}
        return null;
    }

    function isWhitelisted(username) {
        if (!CONFIG.whitelist || CONFIG.whitelist.length === 0) return true;
        if (!username) return false;
        return CONFIG.whitelist.indexOf(String(username).toLowerCase()) !== -1;
    }

    // ── Panggilan ke proxy PHP ────────────────────────────────────────────────
    function proxyUrl(action, query) {
        return CONFIG.proxyUrl +
            (CONFIG.proxyUrl.indexOf('?') === -1 ? '?' : '&') +
            'action=' + action + (query ? '&' + query : '');
    }

    // ── Sisip tab PAY4D (disalin dari createPay4dTab alfael) ───────────────────
    function createPay4dTab() {
        var navTabs = document.getElementById('depo-nav-pills') ||
                      document.getElementById('depo-nav-pills-m') ||
                      document.querySelector('.nav-pills, .nav-tabs, ul.nav');
        if (!navTabs) return false;

        var existingTab = navTabs.querySelector('li');
        if (!existingTab) return false;
        if (document.getElementById('qp-tab')) return true;

        var tabContent = null;
        var sibling = navTabs.nextElementSibling;
        while (sibling) {
            if (sibling.classList && sibling.classList.contains('tab-content')) { tabContent = sibling; break; }
            sibling = sibling.nextElementSibling;
        }
        if (!tabContent) tabContent = document.querySelector('.tab-content');

        var newTab = document.createElement('li');
        newTab.id = 'qp-tab';
        if (existingTab.className) newTab.className = existingTab.className.replace(/\bactive\b/g, '').trim();

        var tabLink = document.createElement('a');
        tabLink.href = '#qp-pane';
        tabLink.setAttribute('data-toggle', 'tab');
        tabLink.innerHTML = '<strong>' + CONFIG.buttonText + '</strong>';
        var existingLink = existingTab.querySelector('a');
        if (existingLink && existingLink.className) {
            tabLink.className = existingLink.className.replace(/\bactive\b/g, '').trim();
        }
        newTab.appendChild(tabLink);
        navTabs.appendChild(newTab);

        if (tabContent) {
            var pane = document.createElement('div');
            pane.id = 'qp-pane';
            pane.className = 'tab-pane fade';
            pane.style.display = 'none';
            pane.innerHTML =
                '<form class="form-group-sm" id="qp-form">' +
                '<div class="well well-sm" style="margin-top:10px;">' +
                '  <div>Deposit via <strong>' + CONFIG.buttonText + '</strong>. Scan QR Code menggunakan e-wallet atau mobile banking Anda.</div>' +
                '</div>' +
                '<div class="form-group">' +
                '  <label>Jumlah</label>' +
                '  <input type="text" class="form-control text-right" id="qp-amount" style="font-weight:bold" placeholder="Masukkan jumlah deposit" onkeyup="var v=this.value.replace(/[^0-9]/g,\'\');this.value=v.replace(/\\B(?=(\\d{3})+(?!\\d))/g,\',\')">' +
                '</div>' +
                '<input type="button" class="btn btn-info btn-block" id="qp-submit" value="Lanjutkan Pembayaran QRIS">' +
                '</form>' +
                '<div id="qp-result" style="display:none;width:100%;margin-top:10px;"></div>';
            tabContent.appendChild(pane);
        }

        if (!document.getElementById('qris-quickpay-style')) {
            var style = document.createElement('style');
            style.id = 'qris-quickpay-style';
            style.innerHTML = '#qp-tab a{cursor:pointer}#qp-tab.active a{font-weight:bold}';
            document.head.appendChild(style);
        }

        // Aktifkan tab QRIS saat diklik
        tabLink.addEventListener('click', function (e) {
            e.preventDefault();
            if (tabContent) {
                tabContent.querySelectorAll('.tab-pane:not(#qp-pane)').forEach(function (p) {
                    p.setAttribute('data-qp-classes', p.className);
                    p.style.display = 'none';
                });
            }
            navTabs.querySelectorAll('li').forEach(function (li) { li.classList.remove('active'); });
            newTab.classList.add('active');
            var qrisPane = document.getElementById('qp-pane');
            if (qrisPane) { qrisPane.className = 'tab-pane fade active in'; qrisPane.style.display = 'block'; }
        });

        // Reset saat pindah ke tab lain
        navTabs.querySelectorAll('li:not(#qp-tab)').forEach(function (li) {
            li.addEventListener('click', function () {
                var qrisPane = document.getElementById('qp-pane');
                if (qrisPane) { qrisPane.style.display = 'none'; qrisPane.className = 'tab-pane fade'; }
                newTab.classList.remove('active');
                var qpForm = document.getElementById('qp-form');
                var container = document.getElementById('qp-result');
                if (qpForm) qpForm.style.display = 'block';
                if (container) { container.style.display = 'none'; container.innerHTML = ''; }
                if (tabContent) {
                    tabContent.querySelectorAll('.tab-pane:not(#qp-pane)').forEach(function (p) {
                        var saved = p.getAttribute('data-qp-classes');
                        if (saved) { p.className = saved; p.removeAttribute('data-qp-classes'); }
                        p.style.display = '';
                    });
                }
            });
        });

        wireSubmit();
        console.log('QRIS Kita: tab PAY4D dibuat');
        return true;
    }

    // ── Submit -> generate -> QR -> polling -> sukses -> reload ────────────────
    function wireSubmit() {
        var checkInterval = null;
        var timerInterval = null;

        setTimeout(function () {
            var submitBtn = document.getElementById('qp-submit');
            if (!submitBtn) return;

            submitBtn.addEventListener('click', function () {
                var amountInput = document.getElementById('qp-amount');
                var amount = amountInput ? amountInput.value.replace(/,/g, '') : '0';
                if (!amount || parseInt(amount, 10) < CONFIG.min) {
                    alert('Minimum deposit: Rp ' + CONFIG.min.toLocaleString('id-ID'));
                    return;
                }
                if (parseInt(amount, 10) > CONFIG.max) {
                    alert('Maximum deposit: Rp ' + CONFIG.max.toLocaleString('id-ID'));
                    return;
                }

                var username = detectUsername() || 'guest';
                submitBtn.disabled = true;
                submitBtn.value = 'Memproses...';

                fetch(proxyUrl('generate'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: username, amount: parseInt(amount, 10) })
                })
                    .then(function (r) { return r.json(); })
                    .then(function (resp) {
                        submitBtn.disabled = false;
                        submitBtn.value = 'Lanjutkan Pembayaran QRIS';

                        if (!resp || !resp.success || !resp.data) {
                            alert((resp && resp.error) || 'Gagal generate QR');
                            return;
                        }
                        var d = resp.data;

                        var qpForm = document.getElementById('qp-form');
                        var container = document.getElementById('qp-result');
                        if (qpForm) qpForm.style.display = 'none';

                        var imgSrc = d.qrImageBase64
                            ? (d.qrImageBase64.indexOf('data:') === 0 ? d.qrImageBase64 : 'data:image/png;base64,' + d.qrImageBase64)
                            : '';
                        var fmtAmt = 'Rp ' + parseInt(d.finalAmount, 10).toLocaleString('id-ID');
                        var expiredAt = new Date(d.expiresAt).getTime();
                        var qrId = d.qrId;

                        container.style.display = 'block';
                        container.innerHTML =
                            '<div class="text-center">' +
                            '<div class="well well-sm" style="margin-top:10px;margin-bottom:15px;"><strong>Scan QR Code menggunakan e-wallet atau mobile banking</strong></div>' +
                            '<div style="background:#fff;border-radius:8px;padding:12px;display:inline-block;margin-bottom:15px;">' +
                            '  <img id="qris-qr-img" src="' + imgSrc + '" style="width:220px;height:220px;" alt="QR Code">' +
                            '</div>' +
                            '<div style="font-size:24px;font-weight:bold;margin:10px 0;">' + fmtAmt + '</div>' +
                            '<div style="font-size:11px;color:#999;margin-bottom:5px;">Kode Unik: ' + (d.uniqueCode != null ? d.uniqueCode : '-') + '</div>' +
                            '<div style="font-size:13px;margin-bottom:15px;word-break:break-all;">' + qrId + '</div>' +
                            '<div id="qris-timer" style="font-size:22px;font-weight:bold;color:#f0ad4e;margin:10px 0;"></div>' +
                            '<div id="qris-status" style="font-size:13px;color:#999;margin-bottom:15px;">Menunggu pembayaran...</div>' +
                            '<div style="display:flex;gap:8px;max-width:320px;margin:0 auto;">' +
                            '  <button type="button" id="qris-dl-btn" class="btn btn-info btn-block" style="flex:1;">Download QR</button>' +
                            '  <button type="button" id="qris-back-btn" class="btn btn-default btn-block" style="flex:1;">Kembali</button>' +
                            '</div></div>';
                        container.scrollIntoView({ behavior: 'smooth', block: 'start' });

                        document.getElementById('qris-dl-btn').addEventListener('click', function () {
                            var a = document.createElement('a');
                            a.href = imgSrc; a.download = 'QRIS_' + qrId + '.png';
                            document.body.appendChild(a); a.click(); document.body.removeChild(a);
                        });
                        document.getElementById('qris-back-btn').addEventListener('click', function () {
                            if (checkInterval) clearInterval(checkInterval);
                            if (timerInterval) clearInterval(timerInterval);
                            container.style.display = 'none'; container.innerHTML = '';
                            if (qpForm) qpForm.style.display = 'block';
                        });

                        // Timer countdown
                        timerInterval = setInterval(function () {
                            var diff = expiredAt - new Date().getTime();
                            var timerEl = document.getElementById('qris-timer');
                            if (!timerEl) { clearInterval(timerInterval); return; }
                            if (diff <= 0) {
                                timerEl.textContent = 'EXPIRED';
                                timerEl.style.color = '#ef4444';
                                var st = document.getElementById('qris-status');
                                if (st) st.textContent = 'QR Code sudah kadaluarsa';
                                clearInterval(timerInterval);
                                if (checkInterval) clearInterval(checkInterval);
                                return;
                            }
                            var mm = Math.floor(diff / 60000);
                            var ss = Math.floor((diff % 60000) / 1000);
                            timerEl.textContent = String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
                        }, 1000);

                        // Polling status via proxy
                        checkInterval = setInterval(function () {
                            fetch(proxyUrl('status', 'qrId=' + encodeURIComponent(qrId) + '&_t=' + new Date().getTime()))
                                .then(function (r) { return r.json(); })
                                .then(function (s) {
                                    var statusEl = document.getElementById('qris-status');
                                    if (!statusEl) { clearInterval(checkInterval); return; }
                                    if (!s || !s.success || !s.data) return;
                                    var sp = String(s.data.statusPay || '').toLowerCase();
                                    if (sp === 'paid' || sp === 'success' || sp === 'settled') {
                                        clearInterval(checkInterval);
                                        clearInterval(timerInterval);
                                        showSuccess(fmtAmt);
                                    } else if (sp === 'expired' || sp === 'failed' || sp === 'cancelled') {
                                        statusEl.textContent = 'Pembayaran ' + sp + '.';
                                    }
                                })
                                .catch(function () {});
                        }, CONFIG.pollIntervalMs);
                    })
                    .catch(function (err) {
                        submitBtn.disabled = false;
                        submitBtn.value = 'Lanjutkan Pembayaran QRIS';
                        alert('Error: ' + err.message);
                    });
            });
        }, 500);
    }

    // ── Layar sukses + reload (saldo dikredit QRIS Kita via depositApiUrl) ─────
    function showSuccess(amtText) {
        var resultDiv = document.getElementById('qp-result');
        if (!resultDiv) { window.location.reload(); return; }
        resultDiv.innerHTML =
            '<div style="text-align:center;padding:30px 15px;">' +
            '  <div style="width:70px;height:70px;border-radius:50%;background:#22c55e;margin:0 auto 15px;display:flex;align-items:center;justify-content:center;">' +
            '    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' +
            '  </div>' +
            '  <div style="font-size:20px;font-weight:700;color:#22c55e;margin-bottom:5px;">PEMBAYARAN BERHASIL!</div>' +
            '  <div style="font-size:14px;color:#999;margin-bottom:15px;">Deposit sedang diproses ke akun Anda</div>' +
            '  <div style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:8px;padding:12px;margin-bottom:20px;">' +
            '    <div style="font-size:12px;color:#999;">TOTAL DIBAYAR</div>' +
            '    <div style="font-size:24px;font-weight:700;color:#22c55e;">' + amtText + '</div>' +
            '  </div>' +
            '  <div style="font-size:13px;color:#888;">Halaman akan refresh dalam <span id="qp-countdown" style="color:#fbbf24;font-weight:700;">5</span> detik...</div>' +
            '</div>';
        var countdown = 5;
        var cdEl = document.getElementById('qp-countdown');
        var cdInterval = setInterval(function () {
            countdown--;
            if (cdEl) cdEl.textContent = countdown;
            if (countdown <= 0) { clearInterval(cdInterval); window.location.reload(); }
        }, 1000);
    }

    // ── Bootstrap: tunggu nav-tabs + cek whitelist (pola initButton alfael) ────
    function init() {
        console.log('QRIS Kita: init...');
        var attempts = 0;

        function tryCreate() {
            var username = detectUsername();
            if (CONFIG.whitelist && CONFIG.whitelist.length > 0 && !isWhitelisted(username)) {
                // Belum ketemu / tidak whitelist — coba lagi beberapa kali
                attempts++;
                if (attempts >= 30) { clearInterval(loop); console.log('QRIS Kita: user tidak whitelist'); }
                return;
            }
            if (createPay4dTab()) { clearInterval(loop); }
            else { attempts++; if (attempts >= 30) { clearInterval(loop); console.log('QRIS Kita: nav-tabs tidak ditemukan'); } }
        }

        var loop = setInterval(tryCreate, 500);
        tryCreate();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 100);
    }
})();
