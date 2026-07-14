#!/usr/bin/env python3
"""
nagox_pending.py — catat 1 "Pending" ke Nagox (POST /pendings) dari menu Uang Pending qris-orkut.

Input (stdin JSON): {
  ref?,                 # id pending lokal (utk jejak/idempotency lunak)
  tanggal_waktu,        # "YYYY-MM-DDTHH:MM" (datetime-local) atau ISO -> jam uang masuk
  user?,                # dugaan username (opsional)
  source_panel,         # nama panel Nagox: "SULEBET"/"ASDTOTO"/...
  nama_bank_pengirim?,  # nama pengirim ("DANA - NOBU / PA***") (opsional)
  bank_penerima_id,     # id bank penerima Nagox (dari konfig site, mis. "466")
  jumlah,               # nominal
  dry_run?              # true = tak POST, cuma pratinjau payload
}
Output: NAGOXPEND_JSON_BEGIN {json} NAGOXPEND_JSON_END
  json = { ok, message, [dry_run], [already], [nagox_id], bank_label, payload }

Idempotency (aksi TAK bisa di-undo): PRE-CHECK daftar pending Nagox -> kalau sudah ada baris
cocok (panel+jumlah+tanggal+user) JANGAN POST lagi. Verifikasi POSITIF via daftar setelah POST.
Kredensial via nagox_service (nagox_config.json). JANGAN log kredensial.
"""
import sys, re, json
sys.path.insert(0, '/opt/qris-orkut/nagox')
import nagox_service as ns
import requests

BASE = ns.BASE
AJAX = {"X-Requested-With": "XMLHttpRequest", "Accept": "application/json"}


def emit(o):
    sys.stdout.write("NAGOXPEND_JSON_BEGIN\n")
    sys.stdout.write(json.dumps(o, ensure_ascii=False))
    sys.stdout.write("\nNAGOXPEND_JSON_END\n")
    sys.stdout.flush()


def digits(x):
    return re.sub(r"[^0-9]", "", str(x if x is not None else ""))


def norm_dt(x):
    # -> "YYYY-MM-DD HH:MM" (Laravel-friendly). Terima "YYYY-MM-DDTHH:MM[:SS]" atau ISO.
    s = str(x or "").strip().replace("T", " ")
    m = re.match(r"(\d{4}-\d{2}-\d{2})[ ]?(\d{2}:\d{2})", s)
    return "%s %s" % (m.group(1), m.group(2)) if m else s


def banks_for_panel(session, panel):
    try:
        r = session.get(BASE + "/pendings", params={"get_banks_by_panel": 1, "panel_filter": panel},
                        headers=AJAX, timeout=30)
        return r.json() if r.status_code == 200 and "application/json" in r.headers.get("content-type", "") else []
    except Exception:
        return []


def pending_dup(session, panel, jumlah, tanggal, user):
    """Cek longgar: apakah daftar pending Nagox sudah punya baris mirip? (halaman1=terbaru).
    Return True (ada), False (tak ada), None (tak tahu/jaringan)."""
    try:
        rr = session.get(BASE + "/pendings", timeout=25)
        if rr.status_code != 200:
            return None
        txt = rr.text
        rphits = digits(jumlah) in digits(txt)  # nominal (kasar)
        # tanggal (YYYY-MM-DD) + jumlah harus dua-duanya muncul utk dianggap dup lunak
        tgl = (tanggal or "")[:10]
        return bool(tgl and (tgl in txt) and rphits and (not user or user in txt))
    except Exception:
        return None


def main():
    try:
        inp = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        emit({"ok": False, "message": "input JSON invalid: %s" % e}); return

    # ── MODE LIST (utk modal konfig): list_panels / list_banks ──
    if inp.get('list_panels') or inp.get('list_banks'):
        try:
            s = ns.make_session()
            if not ns.login(s):
                emit({"ok": False, "message": "gagal login Nagox"}); return
        except Exception as e:
            emit({"ok": False, "message": "gagal akses Nagox: %s" % str(e)[:120]}); return
        if inp.get('list_panels'):
            html = s.get(BASE + "/pendings/create", timeout=30).text
            m = re.search(r'<select\b[^>]*name="source_panel".*?</select>', html, re.S)
            panels = []
            if m:
                for om in re.finditer(r'<option\b[^>]*value="([^"]*)"', m.group(0)):
                    v = om.group(1).strip()
                    if v:
                        panels.append(v)
            emit({"ok": True, "panels": panels}); return
        panel = str(inp.get('source_panel') or '').strip().upper()
        if not panel:
            emit({"ok": False, "message": "source_panel kosong"}); return
        banks = banks_for_panel(s, panel)
        out = [{"id": str(b.get("id")),
                "label": "%s - %s (%s)" % (b.get("nama_rekening"), b.get("rekening_bank"), b.get("no_rekening"))}
               for b in banks]
        emit({"ok": True, "panel": panel, "banks": out}); return

    ref = str(inp.get('ref') or '').strip()
    tgl = norm_dt(inp.get('tanggal_waktu'))
    user = str(inp.get('user') or '').strip()
    panel = str(inp.get('source_panel') or '').strip().upper()
    pengirim = str(inp.get('nama_bank_pengirim') or '').strip()
    bank_id = digits(inp.get('bank_penerima_id'))
    jumlah = int(digits(inp.get('jumlah')) or 0)
    dry = bool(inp.get('dry_run'))

    if not panel:
        emit({"ok": False, "message": "source_panel (site) kosong - dibatalkan"}); return
    if not bank_id:
        emit({"ok": False, "message": "bank_penerima_id kosong - set dulu bank utk site ini di Konfig"}); return
    if jumlah <= 0:
        emit({"ok": False, "message": "jumlah harus > 0"}); return
    if not re.match(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}", tgl):
        emit({"ok": False, "message": "tanggal_waktu tak valid: %s" % tgl}); return

    try:
        s = ns.make_session()
        if not ns.login(s):
            emit({"ok": False, "message": "gagal login Nagox"}); return
    except Exception as e:
        emit({"ok": False, "message": "gagal akses Nagox: %s" % str(e)[:120]}); return

    # Validasi bank_penerima_id ADA di panel ini (anti salah id) + ambil label utk konfirmasi
    banks = banks_for_panel(s, panel)
    match = [b for b in banks if str(b.get("id")) == bank_id]
    if banks and not match:
        emit({"ok": False, "message": "bank_penerima_id %s tak ada di panel %s (cek konfig)" % (bank_id, panel)}); return
    bank_label = None
    if match:
        b = match[0]
        bank_label = "%s - %s (%s)" % (b.get("nama_rekening"), b.get("rekening_bank"), b.get("no_rekening"))

    # GET form -> CSRF
    try:
        r = s.get(BASE + "/pendings/create", timeout=30)
    except Exception as e:
        emit({"ok": False, "message": "gagal buka form: %s" % str(e)[:120]}); return
    if r.status_code != 200:
        emit({"ok": False, "message": "gagal buka /pendings/create (HTTP %s)" % r.status_code}); return
    tok = re.search(r'name="_token"[^>]*value="([^"]+)"', r.text) or \
          re.search(r'name="csrf-token"\s+content="([^"]+)"', r.text)
    if not tok:
        emit({"ok": False, "message": "csrf token tak ditemukan"}); return
    token = tok.group(1)

    payload = {
        "_token": token,
        "tanggal_waktu": tgl,
        "user": user,
        "source_panel": panel,
        "nama_bank_pengirim": pengirim,
        "bank_penerima_id": bank_id,
        "jumlah": str(jumlah),
    }
    preview = {k: v for k, v in payload.items() if k != "_token"}

    if dry:
        emit({"ok": True, "dry_run": True, "bank_label": bank_label, "payload": preview,
              "message": "DRY-RUN: siap kirim (belum di-POST)"}); return

    # PRE-CHECK idempotency (aksi tak bisa undo)
    pre = pending_dup(s, panel, jumlah, tgl, user)
    if pre is True:
        emit({"ok": True, "already": True, "bank_label": bank_label,
              "message": "sudah ada pending mirip di Nagox (panel+jumlah+tanggal) - tidak dikirim ulang"}); return

    # POST
    try:
        pr = s.post(BASE + "/pendings", data=payload,
                    headers={"Referer": BASE + "/pendings/create", "X-CSRF-TOKEN": token,
                             "Content-Type": "application/x-www-form-urlencoded"},
                    timeout=40, allow_redirects=True)
    except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
        chk = pending_dup(s, panel, jumlah, tgl, user)
        if chk is True:
            emit({"ok": True, "message": "tercatat (terverifikasi setelah timeout)", "bank_label": bank_label}); return
        emit({"ok": False, "indeterminate": True, "bank_label": bank_label,
              "message": "timeout/putus saat POST - status TIDAK PASTI, cek manual: %s" % str(e)[:80]}); return
    except Exception as e:
        emit({"ok": False, "message": "error POST: %s" % str(e)[:120], "bank_label": bank_label}); return

    # POST-CHECK: verifikasi POSITIF via daftar
    post = pending_dup(s, panel, jumlah, tgl, user)
    if post is True:
        emit({"ok": True, "message": "tercatat di Nagox (terverifikasi)", "bank_label": bank_label,
              "http": pr.status_code}); return
    # cek error validasi
    low = pr.text.lower()
    fm = re.search(r'alert-(?:success|danger|warning)[^>]*>(.*?)</div>', pr.text, re.S)
    msg = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', fm.group(1))).strip()[:180] if fm else ""
    if post is None:
        emit({"ok": False, "indeterminate": True, "bank_label": bank_label,
              "message": "tak bisa verifikasi ke daftar Nagox - status TIDAK PASTI, cek manual"}); return
    emit({"ok": (pr.status_code in (200, 302)) and not (('is-invalid' in low) or ('was invalid' in low)),
          "message": msg or ("HTTP %s (verifikasi daftar tak menemukan baris)" % pr.status_code),
          "bank_label": bank_label, "http": pr.status_code})


if __name__ == "__main__":
    main()
