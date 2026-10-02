#!/usr/bin/env python3
"""End-to-end: DVhub (mit EEBUS aktiv) ↔ openeebus-Beispiele, nur über DVhubs API.

    e2e-dvhub.py <openeebus-build-dir> [--base http://127.0.0.1] [--token-file /etc/dvhub/config.json]

hems      = Steuerbox (§14a, Energy Guard): wird über /api/eebus/trust als "grid" gekoppelt
heat_pump = EEBUS-Wärmepumpe: wird als "device" gekoppelt
Geprüft wird, was DVhub daraus macht (/api/eebus/status, /api/status).
"""
import json
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

OEB = sys.argv[1]
BASE = sys.argv[sys.argv.index("--base") + 1] if "--base" in sys.argv else "http://127.0.0.1"
CFG = sys.argv[sys.argv.index("--token-file") + 1] if "--token-file" in sys.argv else "/etc/dvhub/config.json"
TOKEN = json.load(open(CFG)).get("apiToken", "")
WORK = tempfile.mkdtemp(prefix="eebus-e2e-")
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""), flush=True)


def api(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}")


def wait(pred, timeout=60, step=1.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = api("GET", "/api/eebus/status")
        try:
            if pred(last):
                return last
        except Exception:
            pass
        time.sleep(step)
    return None


def make_cert(name):
    crt, key = f"{WORK}/{name}.crt", f"{WORK}/{name}.key"
    subprocess.check_call(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
                           "-keyout", key, "-out", crt, "-days", "30", "-subj", f"/CN={name}", "-addext",
                           "subjectKeyIdentifier=hash"], stderr=subprocess.DEVNULL)
    out = subprocess.check_output(["openssl", "x509", "-in", crt, "-noout", "-ext", "subjectKeyIdentifier"], text=True)
    return crt, key, out.strip().splitlines()[-1].strip().replace(":", "").lower()


class Proc:
    def __init__(self, name, argv):
        self.lines = []
        self.p = subprocess.Popen(["stdbuf", "-oL", "-eL", *argv], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, text=True, bufsize=1, errors="replace")
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            self.lines.append(line.rstrip("\n"))

    def send(self, line):
        self.p.stdin.write(line + "\n")
        self.p.stdin.flush()

    def wait_line(self, pattern, timeout=30, start=0):
        rx = re.compile(pattern)
        end = time.time() + timeout
        while time.time() < end:
            for line in self.lines[start:]:
                if rx.search(line):
                    return line
            time.sleep(0.2)
        return None

    def stop(self):
        try:
            self.p.terminate()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


st = wait(lambda s: s.get("status") == "running" and s.get("ski"), 60)
check("DVhub: EEBUS-Dienst läuft", bool(st), json.dumps({k: (st or {}).get(k) for k in ("status", "ski", "port", "error")}))
if not st:
    sys.exit(1)
DV_SKI = st["ski"]

hems_crt, hems_key, SKI_BOX = make_cert("steuerbox")
hp_crt, hp_key, SKI_HP = make_cert("waermepumpe")
r1 = api("POST", "/api/eebus/trust", {"ski": SKI_BOX, "name": "Test-Steuerbox", "role": "grid"})
r2 = api("POST", "/api/eebus/trust", {"ski": SKI_HP, "name": "Test-Wärmepumpe", "role": "device"})
check("Kopplung über die API (Steuerbox + Wärmepumpe)", r1.get("ok") and r2.get("ok"), f"{r1} {r2}")
r3 = api("POST", "/api/eebus/trust", {"ski": "e" * 40, "name": "zweite", "role": "grid"})
check("Zweite Steuerbox wird abgelehnt", r3.get("error") == "grid_peer_exists", json.dumps(r3))

procs = []
try:
    hp = Proc("heat_pump", [f"{OEB}/heat_pump", "4731", DV_SKI, hp_crt, hp_key, "auto"])
    procs.append(hp)
    hems = Proc("hems", [f"{OEB}/hems", "4732", DV_SKI, hems_crt, hems_key, "auto"])
    procs.append(hems)

    def peer(s, ski):
        return next((t for t in s.get("trusted", []) if t["ski"] == ski), {})

    s = wait(lambda s: peer(s, SKI_BOX).get("connected") and peer(s, SKI_HP).get("connected"), 90)
    check("Beide Gegenstellen verbunden", bool(s))
    s = wait(lambda s: s["grid"]["lpc"]["state"] == "unlimited_controlled", 60)
    check("§14a-Zustand: frei, Steuerbox verbunden (unlimited_controlled)", bool(s),
          json.dumps((s or {}).get("grid", {}).get("lpc", {}).get("state")))
    s = wait(lambda s: (peer(s, SKI_HP).get("device") or {}).get("entities", {}).get("lpc"), 30)
    check("Wärmepumpe als steuerbares Gerät erkannt", bool(s))
    hems.wait_line(r"EG LPC", 30)
    time.sleep(3)

    start = len(hp.lines)
    hems.send("eg_lpc set power_limit 4200 PT2H true")
    s = wait(lambda s: s["applied"]["consumptionLimitW"] == 4200, 30)
    check("§14a-Begrenzung 4,2 kW in DVhub aktiv", bool(s), json.dumps((s or {}).get("grid", {}).get("lpc")))
    ctrl = api("GET", "/api/status").get("ctrl", {})
    check("Steuerung: Akku-Netzladen gesperrt (ctrl.eebusConsumptionLimitW)", ctrl.get("eebusConsumptionLimitW") == 4200,
          json.dumps({k: ctrl.get(k) for k in ("eebusConsumptionLimitW", "eebusWallboxCapW")}))
    line = hp.wait_line(r"CS LPC Power Limit received", 30, start)
    check("Grenze an die Wärmepumpe weitergegeben", bool(line), line or "")

    hp.send("mu_mpc set power_total 2100.0")
    s = wait(lambda s: (peer(s, SKI_HP).get("device") or {}).get("powerW") == 2100, 30)
    check("Leistung der Wärmepumpe in DVhub sichtbar", bool(s))

    hems.send("eg_lpp set power_limit -5000 PT1H true")  # Einspeisegrenzen sind <= 0 [LPP-TS-001]
    s = wait(lambda s: s["applied"]["productionLimitW"] == 5000, 30)
    check("Einspeisebegrenzung 5 kW in DVhub aktiv", bool(s), json.dumps((s or {}).get("applied")))

    start = len(hp.lines)
    hems.send("eg_lpc set power_limit 4200 PT2H false")
    s = wait(lambda s: s["applied"]["consumptionLimitW"] is None, 30)
    check("Aufhebung: Bezug wieder frei", bool(s))
    line = hp.wait_line(r"CS LPC Power Limit received .*active = false", 30, start)
    check("Wärmepumpe wieder freigegeben", bool(line), line or "")

    hems.send("eg_lpc set failsafe_limit 3800")
    s = wait(lambda s: s["grid"]["lpc"]["failsafeW"] == 3800, 30)
    check("Failsafe-Wert der Steuerbox übernommen", bool(s))

    hems.stop()
    t0 = time.time()
    s = wait(lambda s: s["grid"]["lpc"]["state"] == "failsafe", 200, 2)
    check("Steuerbox weg → Failsafe mit 3,8 kW", bool(s) and s["applied"]["consumptionLimitW"] == 3800,
          f"nach {round(time.time() - t0)} s: {json.dumps((s or {}).get('applied'))}")
finally:
    for p in procs:
        p.stop()
    for ski in (SKI_BOX, SKI_HP):
        api("DELETE", f"/api/eebus/trust?ski={ski}")
    s = wait(lambda s: s["grid"]["lpc"]["state"] == "disabled", 30)
    check("Entkoppeln: §14a aus, keine Grenze mehr", bool(s) and s["applied"]["consumptionLimitW"] is None)

print(f"\n{sum(results)}/{len(results)} Prüfungen bestanden")
sys.exit(0 if all(results) else 1)
