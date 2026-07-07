/**
 * ============================================================================
 *  QRIS KITA — Embed script untuk halaman deposit ecommerce
 * ============================================================================
 *
 *  Pasang di halaman deposit:
 *    <script src="/path/qris-embed.js"></script>
 *
 *  Script ini TIDAK menyimpan API secret. Ia hanya memanggil qris-proxy.php
 *  di server-mu sendiri, yang menandatangani request ke QRIS Kita.
 *
 *  Alur: user isi nominal -> generate QR -> tampil QR -> polling status ->
 *        saat "paid" tampilkan sukses -> redirect ke onPaidRedirect.
 * ============================================================================
 */
(function () {
    "use strict";

    const CONFIG = {
        enabled: true,

        // URL ke proxy PHP di server ecommerce-mu (BUKAN ke QRIS Kita langsung).
        proxyUrl: "/qris-proxy.php",

        // Elemen tempat widget dirender. Buat <div id="qris-kita"></div> di halaman.
        mountSelector: "#qris-kita",

        // Hanya render untuk username tertentu (kosongkan [] = semua diizinkan).
        // Diisi dari window.QRIS_USER atau atribut data-user pada mount element.
        whitelist: [],

        // Skala tampilan QR.
        qrScaleDesktop: 1.3,
        qrScaleMobile: 1.5,

        // Interval polling status (ms) dan batas waktu total (ms).
        pollIntervalMs: 3000,
        pollTimeoutMs: 12 * 60 * 1000, // samakan dengan QR_EXPIRY_MINUTES

        // Ke mana redirect setelah pembayaran lunas. {qrId} akan diganti.
        // Kosongkan "" untuk tidak redirect (hanya tampilkan sukses).
        onPaidRedirect: "/deposit/sukses?ref={qrId}",
        redirectDelayMs: 1500,
    };

    if (!CONFIG.enabled) return;

    // ── util ────────────────────────────────────────────────────────────────
    function isMobile() {
        return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    }
    function rp(n) {
        return "Rp " + Number(n || 0).toLocaleString("id-ID");
    }
    function el(tag, attrs, html) {
        const e = document.createElement(tag);
        if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
        if (html != null) e.innerHTML = html;
        return e;
    }
    async function api(action, opts) {
        const url =
            CONFIG.proxyUrl +
            (CONFIG.proxyUrl.indexOf("?") === -1 ? "?" : "&") +
            "action=" +
            action +
            (opts && opts.query ? "&" + opts.query : "");
        const res = await fetch(url, {
            method: opts && opts.body ? "POST" : "GET",
            headers: opts && opts.body ? { "Content-Type": "application/json" } : undefined,
            body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
        });
        const json = await res.json().catch(() => ({ success: false, error: "Respons tidak valid" }));
        return json;
    }

    // ── state ────────────────────────────────────────────────────────────────
    let mount = null;
    let pollTimer = null;
    let pollDeadline = 0;

    function whitelistOk(user) {
        if (!CONFIG.whitelist || CONFIG.whitelist.length === 0) return true;
        if (!user) return false;
        return CONFIG.whitelist.map((s) => s.toLowerCase()).indexOf(String(user).toLowerCase()) !== -1;
    }

    function render(html) {
        mount.innerHTML = "";
        mount.appendChild(html);
    }

    // ── layar: form input nominal ─────────────────────────────────────────────
    function renderForm(user) {
        const wrap = el("div", { class: "qk-card" });
        wrap.appendChild(el("div", { class: "qk-title" }, "Pembayaran QRIS"));

        const input = el("input", {
            type: "number",
            class: "qk-input",
            placeholder: "Masukkan nominal (min. 1.000)",
            min: "1000",
        });
        const btn = el("button", { class: "qk-btn" }, "Buat QRIS");
        const msg = el("div", { class: "qk-msg" });

        btn.addEventListener("click", async function () {
            const amount = parseInt(input.value, 10);
            if (!amount || amount < 1000) {
                msg.textContent = "Nominal minimal Rp 1.000";
                return;
            }
            btn.disabled = true;
            btn.textContent = "Memproses...";
            msg.textContent = "";

            const resp = await api("generate", {
                body: { userId: user || "guest", amount: amount },
            });

            if (!resp || !resp.success) {
                msg.textContent = (resp && resp.error) || "Gagal membuat QR";
                btn.disabled = false;
                btn.textContent = "Buat QRIS";
                return;
            }
            renderQr(resp.data);
        });

        wrap.appendChild(input);
        wrap.appendChild(btn);
        wrap.appendChild(msg);
        render(wrap);
    }

    // ── layar: tampilkan QR + polling ─────────────────────────────────────────
    function renderQr(data) {
        const scale = isMobile() ? CONFIG.qrScaleMobile : CONFIG.qrScaleDesktop;
        const size = Math.round(220 * scale);

        const wrap = el("div", { class: "qk-card" });
        wrap.appendChild(el("div", { class: "qk-title" }, "Scan untuk Membayar"));

        const imgSrc = data.qrImageBase64
            ? (data.qrImageBase64.indexOf("data:") === 0
                ? data.qrImageBase64
                : "data:image/png;base64," + data.qrImageBase64)
            : "";
        wrap.appendChild(
            el("img", {
                src: imgSrc,
                class: "qk-qr",
                style: "width:" + size + "px;height:" + size + "px;",
                alt: "QRIS",
            })
        );

        wrap.appendChild(el("div", { class: "qk-amount" }, rp(data.finalAmount)));
        wrap.appendChild(
            el(
                "div",
                { class: "qk-note" },
                "Nominal termasuk kode unik " + (data.uniqueCode != null ? "(" + data.uniqueCode + ")" : "") +
                    "<br>" + (data.qrisAccount ? data.qrisAccount.merchantName : "")
            )
        );

        const status = el("div", { class: "qk-status qk-pending" }, "⏳ Menunggu pembayaran...");
        wrap.appendChild(status);
        render(wrap);

        startPolling(data.qrId, status);
    }

    function stopPolling() {
        if (pollTimer) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
    }

    function startPolling(qrId, statusEl) {
        stopPolling();
        pollDeadline = Date.now() + CONFIG.pollTimeoutMs;

        async function tick() {
            if (Date.now() > pollDeadline) {
                statusEl.className = "qk-status qk-expired";
                statusEl.textContent = "⌛ QRIS kedaluwarsa. Silakan buat ulang.";
                return;
            }
            const resp = await api("status", { query: "qrId=" + encodeURIComponent(qrId) });
            if (resp && resp.success && resp.data) {
                const sp = String(resp.data.statusPay || "").toLowerCase();
                if (sp === "paid" || sp === "success" || sp === "settled") {
                    onPaid(qrId, statusEl);
                    return;
                }
                if (sp === "expired" || sp === "failed" || sp === "cancelled") {
                    statusEl.className = "qk-status qk-expired";
                    statusEl.textContent = "❌ Pembayaran " + sp + ".";
                    return;
                }
            }
            pollTimer = setTimeout(tick, CONFIG.pollIntervalMs);
        }
        pollTimer = setTimeout(tick, CONFIG.pollIntervalMs);
    }

    function onPaid(qrId, statusEl) {
        stopPolling();
        statusEl.className = "qk-status qk-paid";
        statusEl.textContent = "✅ Pembayaran berhasil!";

        // Callback opsional yang bisa dipasang halaman: window.onQrisPaid(qrId)
        if (typeof window.onQrisPaid === "function") {
            try { window.onQrisPaid(qrId); } catch (e) {}
        }

        if (CONFIG.onPaidRedirect) {
            const target = CONFIG.onPaidRedirect.replace("{qrId}", encodeURIComponent(qrId));
            setTimeout(function () {
                window.location.href = target;
            }, CONFIG.redirectDelayMs);
        }
    }

    // ── style ──────────────────────────────────────────────────────────────────
    function injectStyle() {
        if (document.getElementById("qk-style")) return;
        const css =
            ".qk-card{max-width:360px;margin:16px auto;padding:20px;border-radius:14px;" +
            "background:#fff;box-shadow:0 4px 24px rgba(0,0,0,.08);font-family:system-ui,Arial,sans-serif;text-align:center;color:#111}" +
            ".qk-title{font-size:17px;font-weight:700;margin-bottom:14px}" +
            ".qk-input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #d0d5dd;border-radius:9px;font-size:15px;margin-bottom:10px}" +
            ".qk-btn{width:100%;padding:11px;border:0;border-radius:9px;background:#1f7a3d;color:#fff;font-size:15px;font-weight:600;cursor:pointer}" +
            ".qk-btn:disabled{opacity:.6;cursor:default}" +
            ".qk-msg{color:#c0392b;font-size:13px;margin-top:8px;min-height:16px}" +
            ".qk-qr{display:block;margin:0 auto 12px;border-radius:8px}" +
            ".qk-amount{font-size:22px;font-weight:800;margin-bottom:4px}" +
            ".qk-note{font-size:12px;color:#667085;margin-bottom:12px}" +
            ".qk-status{padding:9px;border-radius:8px;font-size:14px;font-weight:600}" +
            ".qk-pending{background:#fff7e6;color:#b7791f}" +
            ".qk-paid{background:#e6f7ec;color:#1f7a3d}" +
            ".qk-expired{background:#fdecec;color:#c0392b}";
        const s = el("style", { id: "qk-style" }, css);
        document.head.appendChild(s);
    }

    // ── boot ────────────────────────────────────────────────────────────────────
    function boot() {
        mount = document.querySelector(CONFIG.mountSelector);
        if (!mount) {
            console.warn("[QRIS Kita] Elemen mount " + CONFIG.mountSelector + " tidak ditemukan.");
            return;
        }
        const user =
            window.QRIS_USER ||
            mount.getAttribute("data-user") ||
            "";

        if (!whitelistOk(user)) {
            console.log("[QRIS Kita] User tidak masuk whitelist, widget disembunyikan.");
            return;
        }
        injectStyle();
        renderForm(user);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
