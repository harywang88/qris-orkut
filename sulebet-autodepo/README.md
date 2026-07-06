# Sulebet Auto-Deposit (Python, standalone) — mode cookie session

Bot auto-deposit member sulebet. Panel `sulebet.com/mimin` login via **Google
OAuth**, jadi bot **tidak bisa login otomatis**. Pola-nya (seperti pay4d
ayuchenbot): Anda login manual sekali di browser via Google, ambil **cookie
`PHPSESSID`**, bot memakai + memperpanjang (keep-alive) cookie itu untuk
meng-accept deposit lewat cron. Kalau cookie mati, bot melapor agar Anda ambil ulang.

Standalone: DB SQLite sendiri, tidak menyentuh skema qris-orkut.

## Isi

| File | Fungsi |
|------|--------|
| `sulebet_panel.py`       | Kelas inti: `is_session_valid()`, `deposit()`, `probe()` (mode cookie) |
| `db.py`                  | Skema SQLite (`sites` dgn cookie, `transactions`) |
| `auto_deposit_worker.py` | Cron worker: ambil tx paid → deposit → tandai hasil |
| `session_prewarm.py`     | Cron keep-alive session (perpanjang umur cookie) |
| `manage.py`              | CLI admin: kelola site/cookie/transaksi, tes cookie & deposit |

## Dependensi

- Python 3.8+ dan `requests` (sudah ada di sistem). Tidak butuh yang lain.

## Setup

```bash
cd /opt/qris-orkut/sulebet-autodepo
mkdir -p logs data
python3 manage.py init
```

**Ambil cookie** (sekali di awal, dan tiap kali cookie mati):
1. Buka `sulebet.com/mimin` di browser, login via Google sampai masuk dashboard admin.
2. F12 → Application → Cookies → salin **value** dari `PHPSESSID`.

```bash
python3 manage.py add-site \
    --name SULEBET \
    --url https://sulebet.com/mimin/ \
    --cookie 'ISI_PHPSESSID_DARI_BROWSER' \
    --bank-id 86

python3 manage.py list-sites
```

`--bank-id` = ID bank tujuan QRIS di panel (default 86; sesuaikan).
Kalau cookie perlu banyak nilai, `--cookie 'PHPSESSID=xxx; other=yyy'` juga didukung.

## Uji

```bash
# Cek cookie valid (tampilkan status login + egress IP)
python3 manage.py test-cookie --site 1

# Tes deposit manual langsung ke panel (tanpa lewat antrian)
python3 manage.py test-deposit --site 1 --member budi --amount 15000
```

Kalau `test-deposit` sukses → cookie & endpoint panel sudah benar.

## Produksi

1. Saat pembayaran QRIS lunas, masukkan ke antrian:
   ```bash
   python3 manage.py add-tx --site 1 --member budi --amount 15000 --ref QR123
   ```
   (Nanti disambung otomatis dari gateway QRIS — lihat "Integrasi".)

2. Cron (lihat `crontab.sample`):
   ```cron
   * * * * * /usr/bin/python3 /opt/qris-orkut/sulebet-autodepo/auto_deposit_worker.py >> /opt/qris-orkut/sulebet-autodepo/logs/auto-deposit.log 2>&1
   * * * * * /usr/bin/python3 /opt/qris-orkut/sulebet-autodepo/session_prewarm.py >> /opt/qris-orkut/sulebet-autodepo/logs/prewarm.log 2>&1
   ```

3. **Saat cookie mati** (bot akan melapor di log), ambil ulang PHPSESSID dari
   browser lalu:
   ```bash
   python3 manage.py set-cookie --site 1 --cookie 'PHPSESSID_BARU'
   ```
   Transaksi yang tertunda saat cookie mati **tidak hilang** — tetap `pending`
   dan otomatis diproses setelah cookie diperbarui.

## State machine `auto_deposited`

| Nilai | Arti |
|-------|------|
| 0 | pending (belum diproses / dikembalikan karena cookie mati) |
| 2 | sedang diproses (lock atomik, anti dobel) |
| 1 | selesai — cek `auto_deposit_success` (0/1) |
| 3 | skip permanen |

Recovery: `=2` lebih dari 10 menit & belum sukses direset ke `0` otomatis.

## Kenapa tidak login otomatis?

Google OAuth punya 2FA + deteksi bot; mengotomasi-nya rapuh dan berisiko akun
diblokir. Cookie session jauh lebih stabil. Keep-alive tiap menit membuat
session bertahan lama (bisa berhari-hari) selama ada aktivitas.

## Integrasi ke gateway QRIS (langkah berikutnya)

Panggil `manage.py add-tx` (atau INSERT langsung ke tabel `transactions`) dari
titik "pembayaran lunas" gateway QRIS, kirim `member_id` (username sulebet),
`amount`, dan `ref` (mis. qrId). Worker mengurus sisanya.
