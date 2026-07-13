#!/usr/bin/env python3
"""
nagox_transfer.py (v2, hardened) — catat 1 transfer Madera->Bank ke Nagox (POST /bank-transfers).
Anti-dobel: pakai REF unik (SettlementRequest.id) yang disisipkan di 'catatan', lalu
verifikasi lewat DAFTAR /bank-transfers (pre-check + post-check). Retry jadi AMAN (idempoten).

Input (stdin JSON): { settlement_id, norek_penerima, bank_penerima?, panel?,
                      nominal, nilai_biaya, jenis_biaya?(=flat), catatan, dry_run? }
Output: NAGOXTF_JSON_BEGIN {json} NAGOXTF_JSON_END
  json = { ok, message, [already], [indeterminate], pengirim, penerima, [dry_run] }

Aturan keamanan:
- penerima match by (norek + bank ternormalisasi), abort bila 0/>1/bank tak cocok.
- panel penerima kosong -> abort. Bila 'panel' (site transaksi) dikirim & != panel penerima -> abort.
- pengirim = 'QRIS KITA' pada panel penerima; abort bila 0/>1.
- timeout/putus SETELAH POST -> status TIDAK PASTI (indeterminate), BUKAN 'fail'.
Kredensial via nagox_service (nagox_config.json). JANGAN log kredensial.
"""
import sys, re, json
sys.path.insert(0, '/opt/qris-orkut/nagox')
import nagox_service as ns
import requests

BASE = ns.BASE


def emit(o):
    sys.stdout.write("NAGOXTF_JSON_BEGIN\n")
    sys.stdout.write(json.dumps(o, ensure_ascii=False))
    sys.stdout.write("\nNAGOXTF_JSON_END\n")
    sys.stdout.flush()


def digits(x):
    return re.sub(r"[^0-9]", "", str(x if x is not None else ""))


def norm_bank(x):
    # normalisasi nama bank: uppercase, buang kata "BANK"/spasi/tanda -> banding token inti
    return re.sub(r"[^A-Z0-9]", "", re.sub(r"\bBANK\b", "", str(x or "").upper()))


def parse_options(block):
    out = []
    for o in re.findall(r'<option\b[^>]*>', block):
        d = dict(re.findall(r'data-([\w-]+)="([^"]*)"', o))
        v = re.search(r'value="([^"]*)"', o)
        if not v or not v.group(1).strip():
            continue
        out.append({
            'id': v.group(1).strip(),
            'bank': (d.get('bank') or '').upper(),
            'nomor': digits(d.get('nomor')),
            'nama': (d.get('nama') or '').strip().upper(),
            'panel': (d.get('panel') or '').strip().upper(),
        })
    return out


def index_has_ref(session, ref):
    """True bila REF sudah muncul di daftar /bank-transfers (halaman pertama = terbaru)."""
    try:
        rr = session.get(BASE + "/bank-transfers", timeout=25)
        return (rr.status_code == 200) and (ref in rr.text)
    except Exception:
        return None  # tak tahu (jaringan)


def main():
    try:
        inp = json.loads(sys.stdin.read() or "{}")
    except Exception as e:
        emit({"ok": False, "message": "input JSON invalid: %s" % e}); return

    ref = str(inp.get('settlement_id') or '').strip()
    norek_pen = digits(inp.get('norek_penerima'))
    bank_pen_raw = (inp.get('bank_penerima') or '')
    bank_pen = norm_bank(bank_pen_raw)
    exp_panel = (inp.get('panel') or '').strip().upper()
    nominal = int(digits(inp.get('nominal')) or 0)
    nilai_biaya = int(digits(inp.get('nilai_biaya')) or 0)
    jenis = (inp.get('jenis_biaya') or 'flat').lower()
    catatan = str(inp.get('catatan') or '')[:250]
    dry = bool(inp.get('dry_run'))

    if not ref:
        emit({"ok": False, "message": "settlement_id (ref) kosong - dibatalkan"}); return
    if not norek_pen:
        emit({"ok": False, "message": "norek penerima kosong"}); return
    if nominal <= 0:
        emit({"ok": False, "message": "nominal harus > 0"}); return

    # login + form
    try:
        s = ns.make_session()
        if not ns.login(s):
            emit({"ok": False, "message": "gagal login Nagox"}); return
        r = s.get(BASE + "/bank-transfers/create", timeout=30)
    except Exception as e:
        emit({"ok": False, "message": "gagal akses Nagox: %s" % str(e)[:120]}); return
    if r.status_code != 200 or 'bank_pengirim_id' not in r.text:
        emit({"ok": False, "message": "gagal buka form create (HTTP %s)" % r.status_code}); return
    page = r.text

    tok = re.search(r'name="_token"[^>]*value="([^"]+)"', page)
    if not tok:
        emit({"ok": False, "message": "csrf token tak ditemukan"}); return
    token = tok.group(1)

    selblk = re.search(r'<select\b[^>]*name="bank_pengirim_id".*?</select>', page, re.S)
    opts = parse_options(selblk.group(0)) if selblk else []
    if not opts:
        emit({"ok": False, "message": "daftar rekening Nagox kosong"}); return

    # penerima: match by norek, WAJIB validasi bank (semua kardinalitas)
    cand = [o for o in opts if o['nomor'] == norek_pen]
    if not cand:
        emit({"ok": False, "message": "rekening penerima %s tidak ada di Nagox" % norek_pen}); return
    if bank_pen:
        by_bank = [o for o in cand if norm_bank(o['bank']) == bank_pen or bank_pen in norm_bank(o['bank']) or norm_bank(o['bank']) in bank_pen]
        if not by_bank:
            emit({"ok": False, "message": "bank penerima (%s) tak cocok utk norek %s - dibatalkan demi keamanan" % (bank_pen_raw, norek_pen)}); return
        cand = by_bank
    if len(cand) > 1:
        emit({"ok": False, "message": "rekening penerima %s ambigu (%d kandidat) - dibatalkan" % (norek_pen, len(cand))}); return
    pen = cand[0]

    if not pen['panel']:
        emit({"ok": False, "message": "panel penerima kosong - pengirim tak bisa ditentukan, dibatalkan"}); return
    if exp_panel and pen['panel'] != exp_panel:
        emit({"ok": False, "message": "penerima di panel %s != site transaksi %s - dibatalkan" % (pen['panel'], exp_panel)}); return

    # pengirim: QRIS KITA panel sama
    send = [o for o in opts if o['nama'] == 'QRIS KITA' and o['panel'] == pen['panel']]
    if not send:
        emit({"ok": False, "message": "rekening 'QRIS KITA' panel %s tak ditemukan" % pen['panel']}); return
    if len(send) > 1:
        emit({"ok": False, "message": "rekening 'QRIS KITA' panel %s ganda - dibatalkan" % pen['panel']}); return
    snd = send[0]
    if snd['id'] == pen['id']:
        emit({"ok": False, "message": "pengirim == penerima, dibatalkan"}); return

    info_pengirim = "%s | %s - %s (%s) [id %s]" % (snd['bank'], snd['nomor'], snd['nama'], snd['panel'], snd['id'])
    info_penerima = "%s | %s - %s (%s) [id %s]" % (pen['bank'], pen['nomor'], pen['nama'], pen['panel'], pen['id'])

    if dry:
        emit({"ok": True, "dry_run": True, "pengirim": info_pengirim, "penerima": info_penerima,
              "nominal": nominal, "nilai_biaya": nilai_biaya, "jenis_biaya": jenis, "catatan": catatan}); return

    # PRE-CHECK idempotency: ref sudah tercatat? -> jangan POST lagi
    pre = index_has_ref(s, ref)
    if pre is True:
        emit({"ok": True, "already": True, "message": "sudah tercatat sebelumnya (ref ditemukan)",
              "pengirim": info_pengirim, "penerima": info_penerima}); return

    # pastikan REF ikut di catatan (backup bila controller belum menyisipkan)
    if ref not in catatan:
        catatan = (catatan + " #" + ref)[:250]

    payload = {
        "_token": token,
        "bank_pengirim_id": snd['id'],
        "bank_penerima_id": pen['id'],
        "nominal_transfer": str(nominal),
        "jenis_biaya": jenis,
        "nilai_biaya": str(nilai_biaya),
        "catatan": catatan,
    }
    posted = False
    try:
        pr = s.post(BASE + "/bank-transfers", data=payload,
                    headers={"Referer": BASE + "/bank-transfers/create", "X-CSRF-TOKEN": token,
                             "Content-Type": "application/x-www-form-urlencoded"}, timeout=40)
        posted = True
    except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
        # request MUNGKIN sudah diterima Nagox -> verifikasi via daftar
        chk = index_has_ref(s, ref)
        if chk is True:
            emit({"ok": True, "message": "tercatat (terverifikasi setelah timeout)",
                  "pengirim": info_pengirim, "penerima": info_penerima}); return
        emit({"ok": False, "indeterminate": True,
              "message": "timeout/putus saat POST - status TIDAK PASTI, verifikasi manual: %s" % str(e)[:80],
              "pengirim": info_pengirim, "penerima": info_penerima}); return
    except Exception as e:
        emit({"ok": False, "message": "error POST: %s" % str(e)[:120],
              "pengirim": info_pengirim, "penerima": info_penerima}); return

    # POST-CHECK: konfirmasi POSITIF via daftar (ref muncul)
    post = index_has_ref(s, ref)
    if post is True:
        emit({"ok": True, "message": "tercatat di Nagox (terverifikasi)",
              "pengirim": info_pengirim, "penerima": info_penerima, "http": pr.status_code}); return

    # ref tak muncul -> cek error validasi di respons POST
    low = pr.text.lower()
    has_err = ('is-invalid' in low) or ('the given data was invalid' in low) or ('whoops' in low)
    msg = ""
    fm = re.search(r'alert-(?:success|danger|warning)[^>]*>(.*?)</div>', pr.text, re.S)
    if fm:
        msg = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', fm.group(1))).strip()[:180]
    if post is None:
        # gagal verifikasi (jaringan) -> tidak pasti
        emit({"ok": False, "indeterminate": True,
              "message": "tak bisa verifikasi ke daftar Nagox - status TIDAK PASTI, cek manual",
              "pengirim": info_pengirim, "penerima": info_penerima}); return
    emit({"ok": False, "message": msg or ("gagal mencatat (ref tak muncul di daftar, HTTP %s)" % pr.status_code),
          "pengirim": info_pengirim, "penerima": info_penerima, "http": pr.status_code})


if __name__ == "__main__":
    main()
