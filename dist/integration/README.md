# QRIS Kita — Paket Integrasi (untuk PENYEDIA payment)

Kamu adalah **penyedia payment** (posisi seperti alfaelpay): kamu menyediakan
QRIS untuk situs operator, kamu **tidak** memegang database saldo mereka.

## Siapa memasang apa

| File | Dipasang oleh | Di mana |
|------|---------------|---------|
| `qris-sulebet-widget.js` | Kamu (via panel admin) | Halaman deposit situs operator |
| Endpoint `/widget/generate` & `/widget/status` | Kamu | Server QRIS Kita (sudah jadi) |
| `deposit-callback.php` + `SPEC-OPERATOR.md` | **Operator** | Server operator |

**Kamu tidak perlu tahu skema tabel saldo operator.** Itu urusan operator —
kamu cukup mengirim notifikasi "lunas" ke URL yang mereka sediakan. Skema saldo
TIDAK ada di script alfael (itu frontend); ia ada di server operator.

## Alur

```
[Browser situs] qris-sulebet-widget.js
   ─GET /qris/widget/generate?key=wk_..&amount=..&member=..─►  QRIS Kita (buat QR)
   ─GET /qris/widget/status?key=wk_..&qrId=..──────────────►  QRIS Kita (cek status)

saat LUNAS:
   QRIS Kita ─POST depositApiUrl (bertanda-tangan HMAC)─►  endpoint operator ─► saldo user +
   lalu script reload halaman → saldo baru tampil
```

## Langkah kamu (penyedia)

### 1. Dashboard QRIS Kita → Clients
Buat 1 client per situs operator:
- Salin **Widget Key** (`wk_...`).
- Isi **Widget Allowed Origins** = origin situs operator (mis. `https://situs.com`).
- Isi **depositApiUrl** = URL callback yang diberikan operator.
- Isi **Deposit API Key** = secret acak → **berikan nilai ini ke operator**
  (dipakai untuk menandatangani & memverifikasi callback).

### 2. Pasang script di situs operator (via panel admin)
Isi `CONFIG` di `qris-sulebet-widget.js`:
```js
baseUrl: 'https://domain-qris-kita-mu/qris',  // termasuk APP_BASE_PATH, tanpa / akhir
key:     'wk_xxx_...'                          // Widget Key
```
Lalu tempel:
```html
<script src="https://cdn-atau-situs/qris-sulebet-widget.js"></script>
```
(atau tempel isinya langsung di kolom custom-script panel).

### 3. Kirim ke operator
- `SPEC-OPERATOR.md` (kontrak callback) + `deposit-callback.php` (contoh).
- Nilai **Deposit API Key** (secret bersama).
- Minta mereka balas dengan **URL endpoint callback** → isikan ke depositApiUrl.

## Keamanan (sudah dibangun & diverifikasi)

- **Widget Key low-privilege**: hanya generate QR & baca status QR-nya sendiri.
- **Origin allowlist**: generate ditolak (403) dari origin lain.
- **Callback bertanda-tangan HMAC**: `X-Deposit-Signature` = HMAC-SHA256 dari
  `timestamp.body` pakai depositApiKey. Operator memverifikasi → deposit palsu
  ditolak. (Signature Node↔PHP sudah diuji cocok.)

## Uji cepat endpoint widget

```bash
curl 'https://domain-qris-kita-mu/qris/widget/generate?key=wk_xxx&amount=15000&member=testuser' \
  -H 'Origin: https://situs.com'
```
Harus balas `{"success":true,"data":{...qrImageBase64...}}`.

## File lain (alternatif, abaikan bila pakai widget)

- `qris-proxy.php` + `qris-sulebet.js` — versi HMAC penuh (butuh proxy PHP di
  server situs). Lebih aman tapi hanya cocok bila kamu punya akses server situs.
- `qris-embed.js` — widget generik untuk situs non-sulebet.

## Catatan
- Nominal final termasuk **kode unik** — user membayar `finalAmount`.
- Kalau username tak terdeteksi, sesuaikan `detectUsername()` di script dengan
  markup halaman situs operator.
