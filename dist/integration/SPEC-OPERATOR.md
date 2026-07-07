# Spesifikasi Integrasi QRIS — untuk OPERATOR situs

Dokumen ini untuk **operator/pemilik situs** yang ingin menerima deposit via
QRIS. Penyedia payment (QRIS Kita) menangani pembuatan QR & deteksi pembayaran;
**operator menyediakan satu endpoint** untuk menerima notifikasi "lunas" dan
mengkreditkan saldo user.

## Pembagian tanggung jawab

| Bagian | Siapa |
|--------|-------|
| Script frontend (tab QRIS, tampilkan QR, polling) | Penyedia (dipasang di situs) |
| Buat QR & deteksi pembayaran | Penyedia (server QRIS Kita) |
| **Endpoint kredit saldo** (`deposit-callback`) | **Operator (server Anda)** |

Yang perlu Anda (operator) kerjakan hanya **satu hal**: buat endpoint HTTP yang
menerima callback di bawah ini dan menambah saldo user.

## Yang Anda terima dari penyedia

1. **Widget Key** (`wk_...`) — dipasang di script frontend.
2. **depositApiKey** — secret bersama untuk verifikasi callback (rahasiakan).

## Yang Anda berikan ke penyedia

1. **URL endpoint callback** Anda, mis. `https://situs-anda.com/qris-deposit.php`
   — penyedia mengisinya ke setelan `depositApiUrl`.
2. Daftar **origin** situs Anda (mis. `https://situs-anda.com`) untuk dikunci.

---

## Kontrak callback (yang WAJIB Anda implementasikan)

Saat pembayaran lunas, QRIS Kita mengirim:

**Request**
```
POST <depositApiUrl Anda>
Content-Type: application/json
X-Deposit-Timestamp: 1783350000
X-Deposit-Signature: <hmac-sha256 hex>
```

**Body (JSON)**
```json
{
  "qrId": "b45bde5b-...",
  "transactionId": "clx...",
  "userId": "budi",
  "requestedAmount": 20000,
  "finalAmount": 20002,
  "paidAmount": 20002,
  "note": "...",
  "issuerName": "GOPAY",
  "rrn": "...",
  "paidAt": "2026-07-06T14:49:19.086Z",
  "externalReference": null
}
```

- `userId` = username user di situs Anda (dideteksi script dari halaman).
- `paidAmount` = jumlah yang harus dikreditkan (sudah termasuk kode unik).
- `qrId` = **kunci idempotensi** — pakai ini agar tidak kredit dua kali.

**Verifikasi signature (WAJIB)**
```
expected = HMAC_SHA256( "<X-Deposit-Timestamp>.<raw_body>", depositApiKey )
```
Bandingkan `expected` dengan header `X-Deposit-Signature` (hex). Tolak bila beda.
Tolak juga bila `X-Deposit-Timestamp` selisih > 300 detik dari waktu server Anda.

**Response yang diharapkan**
- **HTTP 2xx** → deposit dianggap sukses; QRIS Kita berhenti.
- **non-2xx** → QRIS Kita akan retry (beberapa kali, dengan idempotency).

## Kewajiban penting

1. **Verifikasi signature** — tanpa ini, siapa pun bisa memalsukan deposit.
2. **Idempoten** — proses `qrId` yang sama hanya sekali (QRIS Kita bisa retry).
3. **Balas cepat** (< 10 detik) — kalau lama, dianggap gagal & di-retry.

## Contoh implementasi

Lihat `deposit-callback.php` di paket ini — contoh lengkap (PHP/PDO) yang sudah
memverifikasi signature + idempotensi. Anda tinggal menyesuaikan
`creditUserBalance()` ke tabel saldo situs Anda.

## Uji cepat (opsional, dari sisi Anda)

Minta penyedia memicu transaksi uji, atau simulasikan callback:
```bash
BODY='{"qrId":"test1","transactionId":"t1","userId":"budi","paidAmount":10000}'
TS=$(date +%s)
KEY='<depositApiKey Anda>'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$KEY" | sed 's/^.* //')
curl -X POST 'https://situs-anda.com/qris-deposit.php' \
  -H 'Content-Type: application/json' \
  -H "X-Deposit-Timestamp: $TS" \
  -H "X-Deposit-Signature: $SIG" \
  -d "$BODY"
```
Harus balas `{"success":true,...}` dan saldo `budi` bertambah 10000 (sekali saja).
