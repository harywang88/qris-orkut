#!/usr/bin/env python3
"""
nagox_recon.py — Rekonsiliasi ledger Nagox (QRIS KITA rek.466) vs DB qris-orkut.
Deposit + Transfer + Fee + Saldo. SADAR GESER-HARI ±1 hari (uang pending diproses besok / settlement BI-Fast).

  --pull YYYY-MM-DD | --csv PATH ; --json | --tg
Kunci cocok (user+amount) multiset. Baris Nagox masuk-kosong ("-") = penanda booking, DIABAIKAN.
Klasifikasi selisih deposit: DOBEL NAGOX (2 baris <=180dtk), DOBEL DB (manual_booked), HANYA NAGOX/DB (nyata),
  + GESER HARI (ada di sisi lain ±1 hari = uang pending / lintas tengah malam, WAJAR bukan selisih).
"""
import sys, os, re, csv, io, subprocess, json, argparse
from collections import defaultdict, Counter
from datetime import datetime, timedelta, timezone

ENV_PATH = "/opt/qris-orkut/.env"
TG_CFG = "/opt/qris-orkut/data/recon_tg.json"
CACHE_DIR = "/opt/qris-orkut/data/nagox-ledger"
BANK_ID = "466"


def rp(n): return "{:,}".format(int(n or 0)).replace(",", ".")
def digits(s): return int(re.sub(r"[^0-9]", "", str(s)) or "0")


def read_env(key):
    try:
        for line in open(ENV_PATH, encoding="utf-8"):
            m = re.match(r'^\s*' + re.escape(key) + r'\s*=\s*(.*?)\s*$', line)
            if m:
                v = m.group(1)
                return v[1:-1] if len(v) >= 2 and v[0] in "\"'" and v[-1] == v[0] else v
    except Exception:
        pass
    return None


def adj(date_str, days):
    return (datetime.strptime(date_str, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


def wib_today():
    return (datetime.now(timezone.utc) + timedelta(hours=7)).strftime("%Y-%m-%d")


# epoch (UTC) saat hari WIB `date_str` TUTUP = date_str 24:00 WIB = date_str 17:00:00 UTC.
# Cache tanggal-lampau baru boleh dipercaya FINAL bila di-tulis SETELAH ini + margin settlement.
_SETTLE_MARGIN = 900  # 15 menit toleransi (offline Nobu 00:00-00:06 + lag settle ekor hari)


def _wib_day_end_epoch(date_str):
    d = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return (d + timedelta(hours=17)).timestamp()


# ---------- Ledger Nagox ----------
def pull_ledger_text(date_str):
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache = os.path.join(CACHE_DIR, "%s-%s.csv" % (BANK_ID, date_str))
    if os.path.exists(cache):
        import time as _t
        mtime = os.path.getmtime(cache)
        if date_str < wib_today():
            # Tanggal lampau: cache FINAL hanya jika di-snapshot setelah hari WIB itu benar-benar tutup.
            # Kalau ke-snapshot tengah-hari (mis. via menu 21:46), ekor transaksi hilang -> tarik ulang 1x.
            if mtime >= _wib_day_end_epoch(date_str) + _SETTLE_MARGIN:
                return open(cache, encoding="utf-8").read()
        elif _t.time() - mtime < 600:
            return open(cache, encoding="utf-8").read()
    sys.path.insert(0, "/opt/qris-orkut/nagox")
    import nagox_service as ns
    s = ns.make_session()
    if not ns.login(s):
        raise RuntimeError("login Nagox GAGAL")
    u = "/data-banks/%s/export-transactions?tanggal=%s&jenis_transaksi=&status=" % (BANK_ID, date_str)
    r = s.get(ns.BASE + u, timeout=90)
    if r.status_code != 200 or "text/csv" not in r.headers.get("content-type", ""):
        raise RuntimeError("tarik ledger GAGAL http=%s" % r.status_code)
    try:
        open(cache, "w", encoding="utf-8").write(r.text)
    except Exception:
        pass
    return r.text


def pull_safe(date_str):
    try:
        return "" if date_str > wib_today() else pull_ledger_text(date_str)
    except Exception:
        return ""


def parse_ledger(text):
    deps = []
    jenis = defaultdict(lambda: {"cnt": 0, "sum": 0})
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 7 or not (row[0] or "").strip().isdigit():
            continue
        j = (row[2] or "").strip().upper()
        masuk, keluar = digits(row[5]), digits(row[6])
        jenis[j]["cnt"] += 1
        jenis[j]["sum"] += (masuk if masuk else keluar)
        if j == "DEPOSIT" and masuk > 0:  # abaikan baris masuk-kosong (penanda booking, bukan uang)
            deps.append({"user": (row[3] or "").strip(), "amount": masuk, "waktu": (row[1] or "").strip()})

    def sl(lab):
        m = re.search(re.escape(lab) + r'[^0-9-]*"?([0-9.,]+)', text)
        return digits(m.group(1)) if m else 0
    summary = {"saldoAwal": sl("Saldo Awal"), "totalMasuk": sl("Total Masuk"),
               "totalKeluar": sl("Total Keluar"), "saldoAkhir": sl("Saldo Akhir"),
               "depositCnt": len(deps), "pengeluaranCnt": jenis["PENGELUARAN"]["cnt"],
               "pengeluaranSum": jenis["PENGELUARAN"]["sum"], "transferOutCnt": jenis["TRANSFER_OUT"]["cnt"],
               "transferOutSum": jenis["TRANSFER_OUT"]["sum"]}
    return deps, summary


def parse_transfers(text):
    out = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 7 or not (row[0] or "").strip().isdigit():
            continue
        if (row[2] or "").strip().upper() == "TRANSFER_OUT":
            out.append({"amount": digits(row[6]), "bank": re.sub(r'^Ke\s+', '', (row[4] or "").strip()), "waktu": (row[1] or "")[11:]})
    return out


def parse_pengeluaran(text):
    fees, special = [], []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 7 or not (row[0] or "").strip().isdigit():
            continue
        if (row[2] or "").strip().upper() == "PENGELUARAN":
            a = digits(row[6])
            (fees if a == 2500 else special).append(
                {"amount": a, "bank": (row[4] or "").strip(), "operator": (row[8] if len(row) > 8 else "").strip(), "waktu": (row[1] or "")[11:]})
    return fees, special


# ---------- DB ----------
def _win(date_str):
    d = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    gte = (d - timedelta(hours=7)).strftime("%Y-%m-%d %H:%M:%S+00")
    lt = (d - timedelta(hours=7) + timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S+00")
    return gte, lt


def _psql(sql):
    dburl = read_env("DATABASE_URL").split("?")[0]
    o = subprocess.run(["psql", dburl, "-F", "\t", "-At", "-c", sql], capture_output=True, text=True)
    if o.returncode:
        raise RuntimeError("psql: " + o.stderr[:200])
    return o.stdout


def query_deposits_db(date_str):
    gte, lt = _win(date_str)
    out = _psql("SELECT COALESCE(\"userIdExt\",''), \"finalAmount\", COALESCE(\"statusBot\",''), "
                "CASE WHEN COALESCE(\"metadataJson\",'') LIKE '%%pending_booking%%' THEN 1 ELSE 0 END "
                "FROM \"Transaction\" WHERE \"statusPay\"='paid' AND \"paidAt\">='%s' AND \"paidAt\"<'%s'" % (gte, lt))
    rows = []
    for ln in out.splitlines():
        p = ln.split("\t")
        if len(p) >= 4:
            rows.append({"user": p[0].strip(), "amount": digits(p[1]), "statusBot": p[2], "pending": p[3].strip() == "1"})
    return rows


def query_transfers_db(date_str):
    gte, lt = _win(date_str)
    out = _psql("SELECT ABS(amount), substring(\"rawDataJson\" from 'keterangan\"[: ]*\"([^\"]*)') "
                "FROM \"Mutation\" WHERE \"walletCategory\"='madera' AND type='debit' AND \"transactionTime\">='%s' AND \"transactionTime\"<'%s' "
                "AND UPPER(\"rawDataJson\") LIKE '%%BI FAST OUT%%'" % (gte, lt))
    rows = []
    for ln in out.splitlines():
        p = ln.split("\t")
        if p and p[0]:
            rows.append({"amount": digits(p[0]), "bank": re.sub(r'^BI FAST OUT\s*', '', (p[1] if len(p) > 1 else "").strip())})
    return rows


def query_fee3_db(date_str):
    gte, lt = _win(date_str)
    out = _psql("SELECT COUNT(*), COALESCE(SUM(ABS(amount)),0) FROM \"Mutation\" WHERE \"walletCategory\"='madera' "
                "AND \"transactionTime\">='%s' AND \"transactionTime\"<'%s' AND LOWER(\"rawDataJson\") LIKE '%%biaya transfer bi fast%%'" % (gte, lt))
    p = out.strip().split("\t")
    return {"cnt": int(p[0] or 0), "sum": digits(p[1]) if len(p) > 1 else 0}


# ---------- Rekonsiliasi ----------
def _secs(w):
    m = re.search(r'(\d{2}):(\d{2}):(\d{2})', w or "")
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) if m else None


def reconcile_deposit(depsD, dbD, depsAdj, dbAdj, dup_window=180):
    nag = defaultdict(list); dbm = defaultdict(list)
    for d in depsD: nag[(d["user"], d["amount"])].append(d)
    for r in dbD: dbm[(r["user"], r["amount"])].append(r)
    adjNag = Counter((d["user"], d["amount"]) for d in depsAdj)
    adjDb = Counter((r["user"], r["amount"]) for r in dbAdj)
    dobelNagox, hanyaNagox, dobelDb, hanyaDb, geser = [], [], [], [], []
    for key in set(list(nag) + list(dbm)):
        nlist, dlist = nag.get(key, []), dbm.get(key, [])
        user, amount = key
        diff = len(nlist) - len(dlist)
        if diff > 0:  # Nagox lebih
            ss = sorted(x for x in (_secs(y["waktu"]) for y in nlist) if x is not None)
            near = any(ss[i + 1] - ss[i] <= dup_window for i in range(len(ss) - 1))
            for _ in range(diff):
                if near:
                    dobelNagox.append({"user": user, "amount": amount, "waktu": " & ".join(x["waktu"][11:] for x in nlist)})
                elif adjDb[key] > 0:
                    adjDb[key] -= 1
                    geser.append({"user": user, "amount": amount, "side": "nagox", "note": "ada di DB ±1 hari"})
                else:
                    hanyaNagox.append({"user": user, "amount": amount, "waktu": nlist[0]["waktu"][11:] if nlist else ""})
        elif diff < 0:  # DB lebih
            ds = sorted(dlist, key=lambda r: 1 if r["statusBot"] == "manual_booked" else 0)
            for r in ds[len(nlist):]:
                if r["statusBot"] == "manual_booked":
                    dobelDb.append({"user": user, "amount": amount, "statusBot": r["statusBot"]})
                elif adjNag[key] > 0:
                    adjNag[key] -= 1
                    geser.append({"user": user, "amount": amount, "side": "kita", "statusBot": r["statusBot"],
                                  "note": "uang pending diproses beda hari" if r.get("pending") else "lintas tengah malam (±1 hari)"})
                else:
                    hanyaDb.append({"user": user, "amount": amount, "statusBot": r["statusBot"]})
    return {"dobelNagox": dobelNagox, "hanyaNagox": hanyaNagox, "dobelDb": dobelDb, "hanyaDb": hanyaDb, "geser": geser}


def reconcile_transfer(date_str, txtPrev, txtD, txtNext):
    nagD = parse_transfers(txtD)
    nagAdj = parse_transfers(txtPrev) + parse_transfers(txtNext)
    dbD = query_transfers_db(date_str)
    dbAdj = query_transfers_db(adj(date_str, -1)) + query_transfers_db(adj(date_str, 1))
    cNag, cDb = Counter(t["amount"] for t in nagD), Counter(t["amount"] for t in dbD)
    aNag, aDb = Counter(t["amount"] for t in nagAdj), Counter(t["amount"] for t in dbAdj)
    geser, nyata = [], []
    tmp = cNag.copy()
    for t in dbD:
        a = t["amount"]
        if tmp[a] > 0: tmp[a] -= 1
        elif aNag[a] > 0: aNag[a] -= 1; geser.append({"amount": a, "bank": t["bank"], "side": "kita", "note": "ada di Nagox ±1 hari (settlement)"})
        else: nyata.append({"amount": a, "bank": t["bank"], "side": "kita", "note": "TAK ada di Nagox (±1 hari)"})
    tmp2 = cDb.copy()
    for t in nagD:
        a = t["amount"]
        if tmp2[a] > 0: tmp2[a] -= 1
        elif aDb[a] > 0: aDb[a] -= 1; geser.append({"amount": a, "bank": t["bank"], "side": "nagox", "note": "ada di DB ±1 hari (settlement)"})
        else: nyata.append({"amount": a, "bank": t["bank"], "side": "nagox", "note": "TAK ada di DB (±1 hari)"})
    return {"nagoxCnt": len(nagD), "nagoxSum": sum(t["amount"] for t in nagD), "dbCnt": len(dbD), "dbSum": sum(t["amount"] for t in dbD),
            "geser": geser, "nyata": nyata, "match": len(nyata) == 0}


def build_result(date_str, txtD):
    depsD, summary = parse_ledger(txtD)
    txtPrev, txtNext = pull_safe(adj(date_str, -1)), pull_safe(adj(date_str, 1))
    depsAdj = parse_ledger(txtPrev)[0] + parse_ledger(txtNext)[0]
    dbD = query_deposits_db(date_str)
    dbAdj = query_deposits_db(adj(date_str, -1)) + query_deposits_db(adj(date_str, 1))
    dcls = reconcile_deposit(depsD, dbD, depsAdj, dbAdj)
    S = lambda arr: sum(x["amount"] for x in arr)
    real = dcls["dobelNagox"] + dcls["hanyaNagox"] + dcls["dobelDb"] + dcls["hanyaDb"]
    realSel = (S(dcls["dobelNagox"]) + S(dcls["hanyaNagox"])) - (S(dcls["dobelDb"]) + S(dcls["hanyaDb"]))
    deposit = {"nagoxSum": S(depsD), "nagoxCnt": len(depsD), "dbSum": sum(r["amount"] for r in dbD), "dbCnt": len(dbD),
               "selisih": realSel, "match": len(real) == 0, **dcls}
    transfer = reconcile_transfer(date_str, txtPrev, txtD, txtNext)
    fees, special = parse_pengeluaran(txtD)
    fee3 = query_fee3_db(date_str)
    fee = {"nagoxFeeCnt": len(fees), "nagoxFeeSum": sum(f["amount"] for f in fees),
           "special": special, "specialSum": sum(s["amount"] for s in special), "dbFee3Cnt": fee3["cnt"], "dbFee3Sum": fee3["sum"]}
    saldo = {"saldoAwal": summary["saldoAwal"], "totalMasuk": summary["totalMasuk"], "totalKeluar": summary["totalKeluar"],
             "saldoAkhir": summary["saldoAkhir"], "hitung": summary["saldoAwal"] + summary["totalMasuk"] - summary["totalKeluar"],
             "equationOk": (summary["saldoAwal"] + summary["totalMasuk"] - summary["totalKeluar"]) == summary["saldoAkhir"]}
    return {"date": date_str, "bankId": BANK_ID, "ledger": summary, "deposit": deposit, "transfer": transfer, "fee": fee, "saldo": saldo}


# ---------- Output ----------
def tot(lst): return sum(x["amount"] for x in lst)


def text_report(res):
    d, tr, fe, sa, L = res["deposit"], res["transfer"], res["fee"], res["saldo"], []
    L.append("=== CARI SELISIH — NAGOX vs DB — %s (WIB) ===" % res["date"])
    L.append("[DEPOSIT] Nagox %s vs Kita %s | selisih-nyata %s %s" % (rp(d["nagoxSum"]), rp(d["dbSum"]), rp(d["selisih"]), "COCOK" if d["match"] else "SELISIH"))
    for lab, k in [("  DobelNagox", "dobelNagox"), ("  HanyaNagox", "hanyaNagox"), ("  DobelDB", "dobelDb"), ("  HanyaDB", "hanyaDb")]:
        if d[k]:
            L.append("%s: %d = %s -> %s" % (lab, len(d[k]), rp(tot(d[k])), ", ".join("%s %s" % (x["user"], rp(x["amount"])) for x in d[k])))
    if d["geser"]:
        L.append("  ⏱️ geser hari (pending/lintas hari, wajar): %d = %s -> %s" % (len(d["geser"]), rp(tot(d["geser"])), ", ".join("%s %s [%s]" % (x["user"], rp(x["amount"]), x["note"]) for x in d["geser"])))
    L.append("[TRANSFER] Nagox %s (%d) vs Kita %s (%d) | %s" % (rp(tr["nagoxSum"]), tr["nagoxCnt"], rp(tr["dbSum"]), tr["dbCnt"], "COCOK (geser hari wajar)" if tr["match"] else "ADA SELISIH NYATA"))
    if tr["geser"]:
        L.append("  ⏱️ geser hari settlement: %d = %s" % (len(tr["geser"]), rp(tot(tr["geser"]))))
    for x in tr["nyata"]:
        L.append("  ⚠️ NYATA %s Rp%s (%s) %s" % (x["side"], rp(x["amount"]), x["bank"], x["note"]))
    L.append("[FEE] Nagox fee2500 %dx=%s + khusus %s | Kita Fee3 %dx=%s" % (fe["nagoxFeeCnt"], rp(fe["nagoxFeeSum"]), rp(fe["specialSum"]), fe["dbFee3Cnt"], rp(fe["dbFee3Sum"])))
    for s in fe["special"]:
        L.append("  💡 pengeluaran khusus Nagox: Rp%s (%s, op:%s)" % (rp(s["amount"]), s["bank"], s["operator"]))
    L.append("[SALDO] Awal %s + Masuk %s - Keluar %s = %s (ledger %s) %s" % (
        rp(sa["saldoAwal"]), rp(sa["totalMasuk"]), rp(sa["totalKeluar"]), rp(sa["hitung"]), rp(sa["saldoAkhir"]), "✅" if sa["equationOk"] else "❌"))
    return "\n".join(L)


def send_tg(res):
    if not os.path.exists(TG_CFG):
        print("(--tg dilewati)"); return
    try:
        cfg = json.load(open(TG_CFG))
        import urllib.request, urllib.parse
        d, tr = res["deposit"], res["transfer"]
        allok = d["match"] and tr["match"]
        m = "%s <b>Cari Selisih %s</b>\nDeposit: %s" % ("✅" if allok else "⚠️", res["date"], "COCOK" if d["match"] else ("selisih " + rp(d["selisih"])))
        if not d["match"]:
            def ln(lb, arr): return ("\n" + lb + ": " + ", ".join("%s %s" % (x["user"], rp(x["amount"])) for x in arr)) if arr else ""
            m += ln("DobelNagox", d["dobelNagox"]) + ln("HanyaNagox", d["hanyaNagox"]) + ln("DobelDB", d["dobelDb"]) + ln("HanyaDB", d["hanyaDb"])
        if d["geser"]:
            m += "\n(geser hari/pending: %d — wajar)" % len(d["geser"])
        m += "\nTransfer: %s" % ("COCOK (geser hari wajar)" if tr["match"] else ("⚠️ %d selisih NYATA" % len(tr["nyata"])))
        for x in tr["nyata"]:
            m += "\n  ⚠️ %s Rp%s (%s)" % (x["side"], rp(x["amount"]), x["bank"])
        if res["fee"]["special"]:
            m += "\nPengeluaran khusus Nagox: Rp%s" % rp(res["fee"]["specialSum"])
        data = urllib.parse.urlencode({"chat_id": cfg["chat_id"], "text": m, "parse_mode": "HTML"}).encode()
        urllib.request.urlopen(urllib.request.Request("https://api.telegram.org/bot%s/sendMessage" % cfg["token"], data=data), timeout=20)
        print("(TG terkirim)")
    except Exception as e:
        print("(TG gagal:", str(e)[:120], ")")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv"); ap.add_argument("--pull"); ap.add_argument("--date")
    ap.add_argument("--json", action="store_true"); ap.add_argument("--tg", action="store_true")
    a = ap.parse_args()
    try:
        if a.pull:
            date_str = a.pull; text = pull_ledger_text(date_str)
        elif a.csv:
            date_str = a.date or (re.search(r'(\d{4}-\d{2}-\d{2})', os.path.basename(a.csv)) or [None, None])[1]
            if not date_str:
                raise RuntimeError("tanggal tak terbaca; pakai --date")
            text = open(a.csv, encoding="utf-8-sig").read()
        else:
            raise RuntimeError("wajib --pull atau --csv")
        res = build_result(date_str, text)
    except Exception as e:
        if a.json:
            print(json.dumps({"error": str(e)})); return
        print("ERROR:", e); sys.exit(2)
    print(json.dumps(res, ensure_ascii=False) if a.json else text_report(res))
    if a.tg:
        send_tg(res)


if __name__ == "__main__":
    main()
