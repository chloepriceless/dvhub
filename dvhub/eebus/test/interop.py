#!/usr/bin/env python3
"""End-to-end interop test of dvhub-eebus against openeebus' reference programs.

    interop.py <dvhub-eebus> <openeebus-build-dir> [--keep-logs DIR]

Roles:
  hems       (openeebus example) = control box / Energy Guard: sends LPC/LPP limits
             to DVhub and reads DVhub's grid connection point (MA MGCP).
  heat_pump  (openeebus example) = EEBUS device: Controllable System for LPC,
             Monitored Unit (MPC) and Compressor (OHPCF), controlled by DVhub.
  dvhub-eebus = DVhub in the middle (CS towards hems, EG/MA/CEM towards heat_pump).

Every check prints PASS/FAIL; exit code 0 only if all checks pass.
"""
import json
import os
import shutil
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time

BRIDGE, OEB = sys.argv[1], sys.argv[2]
KEEP = sys.argv[sys.argv.index("--keep-logs") + 1] if "--keep-logs" in sys.argv else None
WORK = tempfile.mkdtemp(prefix="eebus-interop-")
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""), flush=True)


def ski_of(cert):
    out = subprocess.check_output(["openssl", "x509", "-in", cert, "-noout", "-ext", "subjectKeyIdentifier"], text=True)
    return out.strip().splitlines()[-1].strip().replace(":", "").lower()


def make_cert(name):
    crt, key = f"{WORK}/{name}.crt", f"{WORK}/{name}.key"
    subprocess.check_call(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
                           "-keyout", key, "-out", crt, "-days", "30", "-subj", f"/CN={name}", "-addext",
                           "subjectKeyIdentifier=hash"], stderr=subprocess.DEVNULL)
    return crt, key


class Proc:
    """Child process with line-buffered stdout collected into a queue + log."""

    def __init__(self, name, argv):
        self.name = name
        self.log = open(f"{WORK}/{name}.log", "w")
        self.p = subprocess.Popen(["stdbuf", "-oL", "-eL", *argv], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT if name != "bridge" else self.log, text=True, bufsize=1,
                                  errors="replace")
        self.q = queue.Queue()
        self.lines = []
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            self.log.write(line)
            self.log.flush()
            self.lines.append(line.rstrip("\n"))
            self.q.put(line.rstrip("\n"))

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
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.terminate()
            self.p.wait(timeout=10)
        except Exception:
            self.p.kill()


class Bridge(Proc):
    def __init__(self, argv):
        super().__init__("bridge", argv)
        self.events = []
        self.next_id = 1

    def _read(self):
        for line in self.p.stdout:
            self.log.write("OUT " + line)
            self.log.flush()
            try:
                self.events.append(json.loads(line))
            except json.JSONDecodeError:
                self.events.append({"ev": "garbage", "line": line})

    def cmd(self, **kw):
        kw["id"] = self.next_id
        self.next_id += 1
        self.log.write("IN  " + json.dumps(kw) + "\n")
        self.send(json.dumps(kw))
        return kw["id"]

    def wait_ev(self, pred, timeout=30, since=0):
        end = time.time() + timeout
        while time.time() < end:
            for ev in self.events[since:]:
                if pred(ev):
                    return ev
            time.sleep(0.2)
        return None


hems_crt, hems_key = make_cert("hems")
hp_crt, hp_key = make_cert("heatpump")
dv_crt, dv_key = f"{WORK}/dvhub.crt", f"{WORK}/dvhub.key"
subprocess.check_call([BRIDGE, "--gen-cert", dv_crt, dv_key, "DVhub-interop"])
SKI_HEMS, SKI_HP, SKI_DV = ski_of(hems_crt), ski_of(hp_crt), ski_of(dv_crt)
print(f"SKIs: dvhub={SKI_DV} hems={SKI_HEMS} heat_pump={SKI_HP}")

procs = []
try:
    bridge = Bridge([BRIDGE, "--port", "4720", "--cert", dv_crt, "--key", dv_key, "--serial", "interop",
                     "--trust", SKI_HEMS, "--trust", SKI_HP])
    procs.append(bridge)
    ready = bridge.wait_ev(lambda e: e.get("ev") == "ready", 20)
    check("Bridge startet und meldet eigene SKI", bool(ready) and ready.get("ski") == SKI_DV, json.dumps(ready))
    bridge.cmd(cmd="grid_config", uc="lpc", nominal_max_w=11000, failsafe_w=4200, failsafe_duration_s=7200)
    bridge.cmd(cmd="grid_config", uc="lpp", nominal_max_w=30000, failsafe_w=30000, failsafe_duration_s=7200)
    ok = bridge.wait_ev(lambda e: e.get("ev") == "reply" and e.get("cmd") == "grid_config" and e.get("ok"), 5)
    check("Netzseite: Nennleistung/Failsafe-Werte gesetzt", bool(ok))

    hp = Proc("heat_pump", [f"{OEB}/heat_pump", "4721", SKI_DV, hp_crt, hp_key, "auto"])
    procs.append(hp)
    hems = Proc("hems", [f"{OEB}/hems", "4722", SKI_DV, hems_crt, hems_key, "auto"])
    procs.append(hems)

    c1 = bridge.wait_ev(lambda e: e.get("ev") == "connected" and e.get("ski") == SKI_HEMS, 60)
    c2 = bridge.wait_ev(lambda e: e.get("ev") == "connected" and e.get("ski") == SKI_HP, 60)
    check("SHIP-Verbindung zur Steuerbox (hems)", bool(c1))
    check("SHIP-Verbindung zum Gerät (heat_pump)", bool(c2))
    eg = bridge.wait_ev(lambda e: e.get("ev") == "grid_eg_added" and e.get("uc") == "lpc", 30)
    check("Steuerbox als Energy Guard für LPC erkannt", bool(eg), json.dumps(eg))
    dev = bridge.wait_ev(lambda e: e.get("ev") == "device_added" and e.get("uc") == "lpc", 30)
    check("Wärmepumpe als steuerbares Gerät (LPC) erkannt", bool(dev), json.dumps(dev))
    mpc = bridge.wait_ev(lambda e: e.get("ev") == "device_added" and e.get("uc") == "mpc", 30)
    check("Wärmepumpe als Messgerät (MPC) erkannt", bool(mpc))
    comp = bridge.wait_ev(lambda e: e.get("ev") == "device_added" and e.get("uc") == "ohpcf", 30)
    check("Verdichter (OHPCF) erkannt", bool(comp))
    hems.wait_line(r"EG LPC|MA MGCP", 30)
    time.sleep(3)

    # --- §14a: Steuerbox -> DVhub ------------------------------------------
    n = len(bridge.events)
    hems.send("eg_lpc set power_limit 4200 PT2H true")
    w = bridge.wait_ev(lambda e: e.get("ev") == "grid_write" and e.get("uc") == "lpc" and e.get("kind") == "limit", 20, n)
    check("LPC-Begrenzung kommt als Schreibanfrage an und wird bestätigt",
          bool(w) and w.get("approved") is True and abs(w.get("w", 0) - 4200) < 0.5 and w.get("duration_s") == 7200
          and w.get("ski") == SKI_HEMS, json.dumps(w))
    lim = bridge.wait_ev(lambda e: e.get("ev") == "grid_limit" and e.get("uc") == "lpc", 20, n)
    check("LPC-Begrenzung 4200 W / 2 h aktiv übernommen",
          bool(lim) and abs(lim.get("w", 0) - 4200) < 0.5 and lim.get("active") is True and lim.get("duration_s") == 7200,
          json.dumps(lim))

    n = len(bridge.events)
    hems.send("eg_lpp set power_limit 8000 PT1H true")
    lpp = bridge.wait_ev(lambda e: e.get("ev") == "grid_limit" and e.get("uc") == "lpp", 20, n)
    check("LPP-Einspeisebegrenzung 8000 W / 1 h übernommen",
          bool(lpp) and abs(lpp.get("w", 0) - 8000) < 0.5 and lpp.get("active") is True, json.dumps(lpp))

    n = len(bridge.events)
    hems.send("eg_lpc set failsafe_limit 3000")
    fs = bridge.wait_ev(lambda e: e.get("ev") == "grid_failsafe_limit" and e.get("uc") == "lpc", 20, n)
    check("Failsafe-Grenze 3000 W übernommen", bool(fs) and abs(fs.get("w", 0) - 3000) < 0.5, json.dumps(fs))
    n = len(bridge.events)
    hems.send("eg_lpc set failsafe_duration PT3H")
    fd = bridge.wait_ev(lambda e: e.get("ev") == "grid_failsafe_duration" and e.get("uc") == "lpc", 20, n)
    check("Failsafe-Dauer 3 h übernommen", bool(fd) and fd.get("duration_s") == 10800, json.dumps(fd))

    n = len(bridge.events)
    hems.send("eg_lpc set power_limit 1 PT1H true")
    bad = bridge.wait_ev(lambda e: e.get("ev") == "grid_write" and e.get("uc") == "lpc", 20, n)
    check("Sehr niedrige Grenze (1 W) wird gemeldet — DVhub entscheidet über die Umsetzung", bool(bad), json.dumps(bad))

    n = len(bridge.events)
    hems.send("eg_lpc set power_limit 4200 PT2H false")
    off = bridge.wait_ev(lambda e: e.get("ev") == "grid_limit" and e.get("uc") == "lpc" and e.get("active") is False, 20, n)
    check("LPC-Begrenzung aufgehoben (active=false)", bool(off), json.dumps(off))

    # --- Netzanschlusspunkt: DVhub -> Steuerbox ----------------------------
    start = len(hems.lines)
    bridge.cmd(cmd="gcp", power_w=-1234.5, energy_consumed_wh=5_000_000, energy_feed_in_wh=12_000_000,
               voltage_l1_v=231.2, current_l1_a=7.5, frequency_hz=50.01)
    line = hems.wait_line(r"MGCP Measurement received: power_total = -1234", 30, start)
    check("Netzanschlusspunkt (MGCP): Leistung kommt bei der Steuerbox an", bool(line), line or "")
    line = hems.wait_line(r"MGCP.*(energy|feed)", 15, start)
    check("Netzanschlusspunkt: Zählerstände kommen an", bool(line), line or "")

    # --- Gerätesteuerung: DVhub -> Wärmepumpe -------------------------------
    entity = dev["entity"] if dev else ""
    start = len(hp.lines)
    rid = bridge.cmd(cmd="device_limit", uc="lpc", entity=entity, w=3000, duration_s=1800, active=True)
    rep = bridge.wait_ev(lambda e: e.get("ev") == "reply" and e.get("id") == rid, 10)
    res = bridge.wait_ev(lambda e: e.get("ev") == "write_result" and e.get("id") == rid, 20)
    line = hp.wait_line(r"CS LPC Power Limit received 3000", 30, start)
    check("Begrenzung 3000 W an die Wärmepumpe geschrieben", bool(rep) and rep.get("ok") and bool(line),
          f"reply={rep} result={res} hp={line}")
    check("Wärmepumpe bestätigt den Schreibvorgang", bool(res) and res.get("ok") is True, json.dumps(res))

    n = len(bridge.events)
    hp.send("mu_mpc set power_total 2500.0")
    m = bridge.wait_ev(lambda e: e.get("ev") == "device_measurement" and e.get("name") == "power_w"
                       and abs(e.get("value", 0) - 2500) < 0.5, 30, n)
    check("Leistung der Wärmepumpe (MPC) kommt bei DVhub an", bool(m), json.dumps(m))

    n = len(bridge.events)
    hp.send("compressor_ohpcf announce 2000 PT1M PT2H PT30S true false")
    a = bridge.wait_ev(lambda e: e.get("ev") == "ohpcf_announce", 30, n)
    check("Flexibler Verdichterlauf (OHPCF) angekündigt", bool(a) and abs(a.get("max_power_w", 0) - 2000) < 0.5, json.dumps(a))
    if a:
        start = len(hp.lines)
        rid = bridge.cmd(cmd="ohpcf", action="schedule", entity=a["entity"], start_in_s=120)
        rep = bridge.wait_ev(lambda e: e.get("ev") == "reply" and e.get("id") == rid, 10)
        line = hp.wait_line(r"(?i)schedul", 30, start)
        check("DVhub plant den Verdichterlauf ein", bool(rep) and rep.get("ok") and bool(line), f"{rep} {line}")

    # --- Heartbeat-Verlust: Steuerbox weg -> Failsafe-Auslöser ---------------
    st = bridge.cmd(cmd="status")
    s = bridge.wait_ev(lambda e: e.get("ev") == "status", 10)
    check("Status: Heartbeat der Steuerbox vorhanden",
          bool(s) and s.get("lpc", {}).get("heartbeat_ok") is True, json.dumps(s))
    n = len(bridge.events)
    hems.stop()
    hb = bridge.wait_ev(lambda e: e.get("ev") == "grid_heartbeat_state" and e.get("lpc_ok") is False, 150, n)
    check("Heartbeat-Verlust der Steuerbox wird erkannt", bool(hb), json.dumps(hb))
    dis = bridge.wait_ev(lambda e: e.get("ev") == "disconnected" and e.get("ski") == SKI_HEMS, 10, n)
    check("Verbindungsabbau gemeldet", bool(dis))

    garbage = [e for e in bridge.events if e.get("ev") == "garbage"]
    check("stdout enthält nur gültiges JSON", not garbage, str(garbage[:2]))

    rss = None
    try:
        with open(f"/proc/{bridge.p.pid}/status") as f:
            rss = int(re.search(r"VmRSS:\s+(\d+)", f.read()).group(1)) // 1024
    except Exception:
        pass
    print(f"Speicher dvhub-eebus: {rss} MB")
finally:
    for p in procs:
        p.stop()
    if KEEP:
        os.makedirs(KEEP, exist_ok=True)
        for f in os.listdir(WORK):
            if f.endswith(".log"):
                shutil.move(f"{WORK}/{f}", f"{KEEP}/{f}")

print(f"\n{sum(results)}/{len(results)} Prüfungen bestanden")
sys.exit(0 if all(results) else 1)
