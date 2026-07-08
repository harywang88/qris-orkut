# Panduan Kerja & Deploy — qris-orkut

Dokumen ini untuk siapa pun (manusia atau AI) yang bantu ngoding di server ini.
Baca dulu sampai habis sebelum mengubah apa pun. Kata-katanya sengaja dibuat sederhana.

---

## 1. Gambaran singkat

- Aplikasi ada di server (VPS) di folder **`/opt/qris-orkut`**.
- Ditulis pakai **TypeScript** di folder **`src/`**, lalu di-**build** (diubah) jadi JavaScript di folder **`dist/`**, baru dijalankan.
- Tampilan halaman web pakai **EJS** di folder **`views/`**.
- Dijalankan pakai **PM2**, ada **2 proses**:
  - **`qris-app`** = web + API (yang dilihat user & operator).
  - **`qris-worker`** = mesin penarik pembayaran otomatis. **Jangan diganggu** tanpa alasan jelas.
- Alamat web: **https://qriskitaoke.com**
- Kode juga tersimpan di **GitHub (privat)**.

---

## 2. ATURAN EMAS (paling penting, jangan dilanggar)

1. **EDIT DI `src/`, JANGAN DI `dist/`.**
   `dist/` itu hasil build otomatis. Kalau kamu edit `dist/` langsung, **editanmu HILANG** begitu di-build ulang. Semua perubahan logika **wajib di `src/`** (atau di `views/` untuk tampilan). *(Ini kesalahan yang paling sering terjadi.)*

2. **File di server ini punya root**, jadi pakai **`sudo`** untuk edit / build / git.

3. **Kalau build ada error, JANGAN restart / deploy.** Perbaiki dulu sampai bersih.

4. **Kode uang** (settlement, transfer, madera, kirim uang) = **hati-hati ekstra**. Test dulu, jangan buru-buru.

---

## 3. Cara masuk ke server (SSH)

Koko akan kirim **SSH key + user + password** secara pribadi. Setelah dapat:

```bash
ssh -i <file-key> <user>@<ip-server>
```

---

## 4. Alur deploy — urut, langkah demi langkah

```bash
cd /opt/qris-orkut

# 1) Tarik versi terbaru dulu (biar tidak bentrok dengan orang lain)
sudo git pull

# 2) EDIT kode di src/...  (atau tampilan di views/...)

# 3) Kalau mengubah struktur database (file prisma/schema.prisma):
sudo npx prisma db push

# 4) BUILD  (WAJIB — ini yang mengubah src jadi dist)
sudo env PATH=$PATH npm run build
#    -> Harus BERSIH. Kalau muncul "error TS...", perbaiki dulu. JANGAN lanjut.

# 5) RESTART aplikasi:
sudo pm2 restart qris-app          # untuk perubahan web / API / tampilan
# sudo pm2 restart qris-worker     # HANYA kalau mengubah kode worker/penarik

# 6) CEK hidup
sudo pm2 status                    # qris-app harus "online"
#    Lalu buka https://qriskitaoke.com dan pastikan normal.

# 7) SIMPAN ke GitHub
sudo git add <file-yang-diubah>
sudo git commit -m "pesan jelas: apa yang diubah"
sudo git push
```

**Ringkasnya:** `git pull` → edit `src/` → build → restart `qris-app` → cek → `git push`.

---

## 5. Kalau ada masalah

```bash
# Lihat error aplikasi:
sudo pm2 logs qris-app --lines 50

# Batalkan editan yang BELUM di-commit (balik ke versi terakhir):
sudo git checkout -- <file>

# Restart ulang kalau app nyangkut:
sudo pm2 restart qris-app
```

**Backup sebelum edit besar:** `sudo cp namafile namafile.bak`

---

## 6. Yang WAJIB dihindari

- ❌ Jangan edit folder `dist/` (hilang saat build).
- ❌ Jangan commit / bocorkan file **`.env`** (isinya rahasia: password, kunci, token).
- ❌ Jangan restart `qris-worker` sembarangan (itu penarik pembayaran).
- ❌ Jangan bilang "selesai" sebelum: build bersih + app online + halaman dites.
- ❌ Jangan dua orang edit file yang sama di waktu yang sama — koordinasi dulu.

---

## 7. Catatan untuk AI

- Selalu **baca isi file yang sebenarnya** sebelum mengedit — jangan menebak dari ingatan.
- Setelah edit: **build → restart → test**. Baru laporkan hasil apa adanya.
- Perubahan tampilan (`views/*.ejs`) tidak butuh build TypeScript, **tapi tetap** `sudo pm2 restart qris-app` supaya halaman ter-refresh (view di-cache).
- Untuk menjalankan skrip Node yang baca database, jalankan **dari dalam `/opt/qris-orkut`** (biar `.env` kebaca), pakai `sudo node`.
- Fitur hak akses operator (menu "Akun Alias") itu penting — jangan sampai celah izin terbuka. Endpoint uang harus tetap terkunci izin.
