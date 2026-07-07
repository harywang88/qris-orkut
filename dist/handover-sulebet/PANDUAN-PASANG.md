# Panduan Pasang QRIS — untuk Pihak SULEBET

Paket ini menghubungkan halaman deposit sulebet ke gateway QRIS. Sudah terisi &
siap pasang.

## Isi paket

| File | Untuk apa |
|------|-----------|
| `qris-sulebet-widget.js` | Script frontend — **sudah terisi**, tinggal pasang |
| `SPEC-OPERATOR.md` | Spesifikasi callback kredit saldo (untuk tim server) |
| `deposit-callback.php` | Contoh handler kredit saldo (untuk tim server) |

---

## BAGIAN 1 — Pasang script frontend (wajib)

Script `qris-sulebet-widget.js` **sudah berisi** koneksi ke gateway:
- `baseUrl: https://sayang.harywang.online/qris`
- `key: wk_sulebet_...` (widget key, aman di browser)

Cara pasang — pilih salah satu:

**A. Panel punya kolom "Custom Script / Footer JS":**
Tempel seluruh isi `qris-sulebet-widget.js` (dibungkus tag `<script>...</script>`)
ke kolom itu, simpan.

**B. Bisa upload file:**
Upload `qris-sulebet-widget.js` ke root situs, lalu tambahkan sebelum `</body>`:
```html
<script src="/qris-sulebet-widget.js"></script>
```

Setelah terpasang, buka halaman deposit → akan muncul tab **"QRIS QuickPay"**.
User pilih tab itu → isi nominal → tampil QR → scan → bayar.

---

## BAGIAN 2 — Kredit saldo otomatis (untuk tim server sulebet)

Script frontend **hanya menampilkan** QR & status. Agar **saldo user bertambah
otomatis** saat pembayaran lunas, tim server sulebet perlu membuat **satu
endpoint** yang menerima notifikasi pembayaran dari gateway.

Lihat `SPEC-OPERATOR.md` untuk kontrak lengkap + `deposit-callback.php` sebagai
contoh siap-pakai (verifikasi signature + idempotensi sudah ada; tinggal
sesuaikan `creditUserBalance()` ke tabel saldo sulebet).

Yang dibutuhkan tim server:
1. Buat endpoint (mis. `https://sulebet.com/qris-deposit.php`).
2. Verifikasi header `X-Deposit-Signature` (HMAC — cara di SPEC).
3. Tambah saldo user berdasarkan `userId` + `paidAmount`, idempoten per `qrId`.
4. **Beri tahu penyedia URL endpoint ini** → penyedia menyambungkannya.

Penyedia akan memberikan **Deposit API Key** (secret) via channel privat untuk
verifikasi signature.

---

## Penting

- **Tanpa Bagian 2, saldo user TIDAK bertambah otomatis** — QR tampil & pembayaran
  masuk, tapi kredit saldo perlu endpoint di server sulebet.
- Nominal yang dibayar user = nominal + kode unik kecil (untuk pencocokan
  otomatis). Ini normal.
- Jika tab QRIS tidak muncul / username salah terdeteksi, kirim ke penyedia
  contoh HTML halaman deposit sulebet agar selektor disesuaikan.
