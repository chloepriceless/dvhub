#!/usr/bin/env python3
"""Golden-Werte fuer services/optimizer/ev-minmax.js aus dem Python-Port der Simulation.

Quelle der Logik: eos-bench/ev-minmax/evsim.py (propagate_min, future_cost_curve, value_steps und die
Ableitung der EOS-Parameter je Lauf), dort gegen 115 Laeufe und 5 Codex-Runden geprueft. Dieses Skript
rechnet synthetische, aber realistische Lagen (Preise, PV, Fahrten) mit genau diesen Funktionen und
schreibt Eingaben + Ergebnisse nach ev-minmax-golden.json. Der JS-Test rechnet dieselben Eingaben und
vergleicht min, max, Wertstufen und die Kostenkurve.

  EVSIM_DIR=~/Projects/eos-bench/ev-minmax PYTHONPATH=<eos src>:<pydeps> python gen-ev-minmax-golden.py

Neu erzeugen nur, wenn sich evsim.py aendert; die JSON-Datei ist eingecheckt.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.expanduser(os.environ.get("EVSIM_DIR", "~/Projects/eos-bench/ev-minmax")))
import evsim  # noqa: E402

TZ = evsim.TZ
SLOT = evsim.SLOT


class FakeData:
    """Wie evsim.Data, aber mit synthetischen Reihen: Preise je Slot direkt (imp/fit), PV und Grundlast."""

    def __init__(self, t0: dt.datetime, days: int, seed: int, *, neg_day: int | None = None, pv_scale: float = 1.0):
        self.t0 = int(t0.timestamp())
        n = days * 96
        self.ts = self.t0 + SLOT * np.arange(n)
        rnd = np.random.default_rng(seed)
        spot = np.empty(n)
        pv = np.empty(n)
        base = np.empty(n)
        for i in range(n):
            d = dt.datetime.fromtimestamp(int(self.ts[i]), TZ)
            h = d.hour + d.minute / 60
            day = (d.date() - t0.date()).days
            # Abendspitze, billige Nacht, Mittagsdelle; Tag 3 windig (billig)
            s = 9.0 + 6.0 * math.cos((h - 19) / 24 * 2 * math.pi) - 4.0 * math.exp(-((h - 13) / 2.5) ** 2)
            s += 2.0 * math.sin(day / 7 * 2 * math.pi)
            if day == 3:
                s -= 6.0
            if neg_day is not None and day == neg_day and 10 <= h < 15:
                s = -4.0 - 3.0 * math.exp(-((h - 12.5) / 1.2) ** 2)
            spot[i] = round(s + rnd.normal(0, 0.8), 3)
            sun = max(0.0, math.sin((h - 7.5) / 9.5 * math.pi)) if 7.5 <= h <= 17 else 0.0
            pv[i] = round(pv_scale * 2600 * sun * (0.6 + 0.4 * rnd.random()), 1)
            base[i] = round(110 + 60 * math.exp(-((h - 19) / 2) ** 2) + 30 * rnd.random(), 1)
        self.spot = spot
        self.imp = np.round(evsim.LB_A * spot + evsim.LB_B, 6)
        self.fit = np.where(spot >= 0, spot + evsim.PREMIUM_CT, spot)
        self.pv = pv
        self.base = base

    def idx(self, t: dt.datetime) -> int:
        return (int(t.timestamp()) - self.t0) // SLOT


def patch(data: FakeData) -> None:
    evsim.spot_view = lambda d, t, i0, n: (d.imp[i0:i0 + n].copy(), n)  # noqa: E731
    evsim.import_fit = lambda d, spot, i0, n_real: (spot.copy(), d.fit[i0:i0 + len(spot)].copy())  # noqa: E731


def set_ev(p_w: float, cap_wh: float) -> None:
    evsim.EV_P_W = float(p_w)
    evsim.EV_CAP_WH = float(cap_wh)
    evsim.EV_SLOT_STORED_PCT = evsim.EV_P_W * SLOT / 3600 * evsim.EV_ETA / evsim.EV_CAP_WH * 100


def at(day0: dt.date, off: int, hhmm: str) -> dt.datetime:
    return evsim.at_time(day0 + dt.timedelta(days=off), hhmm)


def surplus_series(data: FakeData, t: dt.datetime, i0: int, n: int) -> list:
    """Der PV-Ueberschuss je Slot, wie future_cost_curve ihn nimmt (bis 72 h echt, dahinter Median je
    Viertelstunde der letzten 7 Tage)."""
    i_now = data.idx(t)
    i_pv_known = i_now + evsim.PRED_H * 4
    prof: dict = {}
    for k in range(i_now - 7 * 96, i_now):
        prof.setdefault(evsim.tod_key(int(data.ts[k])), []).append(max(0.0, data.pv[k] - data.base[k]))
    med = {key: float(np.median(v)) for key, v in prof.items()}
    out = []
    for i in range(i0, i0 + n):
        out.append(max(0.0, float(data.pv[i] - data.base[i])) if i < i_pv_known else med.get(evsim.tod_key(int(data.ts[i])), 0.0))
    return out, {str(k): v for k, v in med.items()}, [
        {"ms": int(data.ts[k]) * 1000, "wh": max(0.0, float(data.pv[k] - data.base[k]))} for k in range(i_now - 7 * 96, i_now)]


def iso(x: dt.datetime) -> str:
    return x.isoformat()


def ms(x: dt.datetime) -> int:
    return int(x.timestamp()) * 1000


def scenario(name, *, t, trips, max_soc, p_w, cap_wh, ctrl_h, soc_now, seed, margin=1.0, present=True,
             arrive=None, neg_day=None, pv_scale=1.0):
    set_ev(p_w, cap_wh)
    start = (t - dt.timedelta(days=8)).replace(hour=0, minute=0)
    data = FakeData(start, 22, seed, neg_day=neg_day, pv_scale=pv_scale)
    patch(data)
    t_ctrl_end = dt.datetime.fromtimestamp(t.timestamp() + ctrl_h * 3600, TZ)
    kn = trips
    ref = t if present else arrive
    future = [x for x in kn if x.dep >= ref and x.dep > t]
    out = {"name": name, "t": iso(t), "tMs": ms(t), "ctrlEndMs": ms(t_ctrl_end), "maxSocPct": max_soc,
           "chargeW": p_w, "capacityWh": cap_wh, "eta": evsim.EV_ETA, "marginCt": margin, "socNowPct": soc_now,
           "present": present, "arriveMs": ms(arrive) if arrive else None,
           "trips": [{"depMs": ms(x.dep), "retMs": ms(x.ret), "tripPct": x.trip, "minPct": x.min} for x in kn]}
    nxt = future[0]
    req = evsim.propagate_min(future)
    mn = int(math.ceil(req - 1e-9))
    mx = max(max_soc, mn)
    soc_i = math.floor(soc_now + 1e-9)
    e_time = nxt.dep if nxt.dep < t_ctrl_end else t_ctrl_end
    steps, vinfo = evsim.value_steps(data, t, e_time, float(mn), mx, kn, margin)
    # Kostenkurve direkt (fuer den Vergleich der DP selbst)
    top = min(mx, 100.0)
    grid, cost, info = evsim.future_cost_curve(data, t, e_time, top, kn)
    i_base = data.idx(t)
    i_w = data.idx(e_time + dt.timedelta(days=7))
    n = i_w - i_base + 1
    sur, med, past = surplus_series(data, t, i_base, n)
    out["inputs"] = {"baseMs": int(data.ts[i_base]) * 1000, "slotMs": SLOT * 1000,
                     "importCt": [float(x) for x in data.imp[i_base:i_base + n]],
                     "feedInCt": [float(x) for x in data.fit[i_base:i_base + n]],
                     "surplusWh": sur, "pastSurplus": past, "pastMedian": med}
    out["expect"] = {"propagated": req, "minSocPct": mn, "maxSocPct": mx, "initialSocPct": max(0, min(100, int(soc_i))),
                     "eMs": ms(e_time), "deadlineMs": ms(nxt.dep), "steps": steps,
                     "valueReason": vinfo.get("reason"), "cSe": vinfo.get("c_se"),
                     "impMaxCt": info["imp_max_ct"], "dpCap": info["dp_cap"], "nTrips": info["n_trips"],
                     "gridLen": int(len(grid)), "gridSample": [float(x) for x in grid[::7]],
                     "costSample": [float(x) for x in cost[::7]], "costTop": float(cost[-1]), "cost0": float(cost[0])}
    return out


def weekly(day0, entries, days=16):
    """entries: (Tag ab day0, Abfahrt, Tage bis Rueckkehr, Rueckkehr, Fahrt %, Min %)."""
    out = []
    for off, dep, dret, ret, trip, mn in entries:
        out.append(evsim.Trip(at(day0, off, dep), at(day0, off + dret, ret), trip, mn, "weekly"))
    out.sort(key=lambda x: x.dep)
    return out


def main() -> None:
    mon = dt.date(2026, 11, 16)  # Montag, weit weg von jeder Zeitumstellung
    sc = []
    # 1. Christins Muster (christin2): Di + Mi 30 %, sonst 5-10 %, Mo 20:00 angesteckt
    ent = []
    for w in (0, 7):
        ent += [(w + 1, "07:00", 0, "18:00", 30, 50), (w + 2, "07:00", 0, "18:00", 30, 50)]
        ent += [(w + d - 1, "10:30", 0, "12:00", p, 30) for d, p in ((1, 10), (4, 5), (5, 10), (6, 5), (7, 10))]
    trips = weekly(mon, ent)
    sc.append(scenario("christin2-mo-abend", t=at(mon, 0, "20:00"), trips=trips, max_soc=80, p_w=11000, cap_wh=75000,
                       ctrl_h=28, soc_now=46.7, seed=1))
    # 2. dasselbe, Abfahrt hinter dem Steuerzeitraum (E = Ende des Steuerzeitraums)
    sc.append(scenario("christin2-kurzer-horizont", t=at(mon, 0, "20:00"), trips=trips, max_soc=80, p_w=11000,
                       cap_wh=75000, ctrl_h=6, soc_now=52.0, seed=1))
    # 3. kurzwende: Sa zwei Fahrten mit 1 h Pause - vorausschauendes Mindestziel
    ent = []
    for w in (0, 7):
        ent += [(w + 2, "07:00", 0, "18:00", 20, 40), (w + 5, "09:00", 0, "12:00", 40, 45), (w + 5, "13:00", 0, "18:00", 35, 40)]
    sc.append(scenario("kurzwende-fr-abend", t=at(mon, 4, "22:00"), trips=weekly(mon, ent), max_soc=80, p_w=11000,
                       cap_wh=75000, ctrl_h=30, soc_now=35.2, seed=2))
    # 4. wochenende: Min 85 > Max 80 (Max steigt auf Min, keine Wertstufen)
    ent = []
    for w in (0, 7):
        ent += [(w + 2, "18:00", 0, "21:00", 6, 25), (w + 4, "15:00", 2, "19:00", 65, 85)]
    sc.append(scenario("wochenende-do-nacht", t=at(mon, 3, "23:00"), trips=weekly(mon, ent), max_soc=80, p_w=11000,
                       cap_wh=75000, ctrl_h=24, soc_now=40.0, seed=3))
    # 5. kleine Wallbox 3,7 kW einphasig, Pendler 15 %
    ent = []
    for w in (0, 7):
        ent += [(w + d, "07:30", 0, "17:30", 15, 35) for d in range(0, 5)] + [(w + 5, "10:00", 0, "14:00", 10, 25)]
    sc.append(scenario("klein37-di-abend", t=at(mon, 1, "19:00"), trips=weekly(mon, ent), max_soc=80, p_w=3700,
                       cap_wh=75000, ctrl_h=30, soc_now=30.9, seed=4))
    # 6. grosse Wallbox 22 kW, kleiner Akku 50 kWh, Max 100
    sc.append(scenario("gross22-50kwh", t=at(mon, 1, "19:00"), trips=weekly(mon, ent), max_soc=100, p_w=22000,
                       cap_wh=50000, ctrl_h=30, soc_now=44.4, seed=5))
    # 7. Sommer: viel PV, negative Preise am Tag 2
    sc.append(scenario("sommer-negativ", t=at(mon, 0, "21:00"), trips=weekly(mon, ent), max_soc=80, p_w=11000,
                       cap_wh=75000, ctrl_h=27, soc_now=60.0, seed=6, neg_day=2, pv_scale=3.5))
    # 8. Schicht: Nachtschicht Mo-Fr 21:30-06:30, unausgerichtete Zeiten
    ent = []
    for w in (0, 7):
        ent += [(w + d, "21:40", 1, "06:20", 20, 40) for d in range(0, 5)]
    sc.append(scenario("schicht-unausgerichtet", t=at(mon, 1, "07:00"), trips=weekly(mon, ent), max_soc=80, p_w=11000,
                       cap_wh=75000, ctrl_h=33, soc_now=21.5, seed=7))
    # 9. Vorplanung: Auto unterwegs, Ankunft 18:00 im Steuerzeitraum
    ent = []
    for w in (0, 7):
        ent += [(w + d, "07:30", 0, "18:00", 25, 45) for d in range(0, 5)]
    tr = weekly(mon, ent)
    sc.append(scenario("vorplanung-unterwegs", t=at(mon, 1, "12:00"), trips=tr, max_soc=80, p_w=11000, cap_wh=60000,
                       ctrl_h=30, soc_now=55.0 - 25, seed=8, present=False, arrive=at(mon, 1, "18:00")))
    # 10. selten daheim: Mo 07:00 - Fr 18:00 weg, Sa/So laden
    ent = [(0, "07:00", 4, "18:00", 50, 70), (7, "07:00", 4, "18:00", 50, 70)]
    sc.append(scenario("selten-sa", t=at(mon, 5, "09:00"), trips=weekly(mon, ent), max_soc=80, p_w=11000,
                       cap_wh=75000, ctrl_h=40, soc_now=24.0, seed=9))
    Path(__file__).with_name("ev-minmax-golden.json").write_text(json.dumps({
        "source": "eos-bench/ev-minmax/evsim.py (propagate_min, future_cost_curve, value_steps, Ableitung je Lauf)",
        "generated": dt.date.today().isoformat(), "timeZone": "Europe/Berlin", "scenarios": sc}, separators=(",", ":")))
    for s in sc:
        e = s["expect"]
        print(f"{s['name']:28s} req={e['propagated']:.3f} min={e['minSocPct']} max={e['maxSocPct']} "
              f"steps={e['steps']} reason={e['valueReason']} grid={e['gridLen']}")


if __name__ == "__main__":
    main()
