# Python QRIS Balance Watcher

Service ini dibuat untuk mode `Python Balance Standby`.

Alurnya:

1. Cek saldo QRIS ringan via endpoint `account`
2. Kalau saldo berubah, baru tarik `qris_history`
3. Simpan mutasi baru ke PostgreSQL
4. Tulis `outbox_event` agar UI/worker Node bisa ikut sinkron

Mode ini cocok untuk merchant yang ingin:

- update cepat saat ada transaksi nyata
- lebih hemat request saat tidak ada perubahan
- mengurangi risiko `469` dari `qris_history`

## Install

```bash
pip install -r python/requirements.txt
```

## Jalankan sekali

```bash
python python/qris_balance_watcher.py --once
```

## Jalankan standby terus

```bash
python python/qris_balance_watcher.py
```

## Catatan

- Worker ini memantau merchant aktif yang punya kredensial app OrderKuota
- Runtime sekarang diarahkan ke model `Python Balance Standby` sebagai jalur utama
- Watcher saldo aktif dan RRN detail diambil langsung dari tabel `QrisAccount`
- Fallback sync mutasi berkala sudah dimatikan agar tidak ikut memicu 469
