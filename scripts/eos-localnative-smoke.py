"""Rauchtest Image dvhub-eos-localnative: die Fassade dvhub-optimize serve laeuft
und ist der 0.2.0-Kern mit unseren Aenderungen (D #1531, E #1532).

Genutzt von .github/workflows/container-eos-localnative.yml: im laufenden
Container (je Architektur) vor dem Veroeffentlichen, nur Python-stdlib.

    python eos-localnative-smoke.py [PORT]      (Vorgabe: $EOS_PORT oder 8503)

1. GET /v1/health antwortet "alive" und "native": true.
2. Nach PUT einer Batterie und eines Wechselrichters zeigt GET /v1/config die
   Felder soc_value_steps (E, Batterie) und max_grid_import_power_w (D,
   Wechselrichter). Ein 0.1.0-Kern kennt sie nicht -> rot.
Exit 0 nur, wenn beides gilt; sonst 1 und eine Zeile "FAIL: ...".
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request


def main() -> int:
    port = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("EOS_PORT", "8503")
    base = f"http://127.0.0.1:{port}"

    health = None
    for _ in range(60):
        try:
            with urllib.request.urlopen(base + "/v1/health", timeout=3) as r:
                health = json.load(r)
            break
        except Exception:
            time.sleep(1)
    if health is None:
        print(f"FAIL: {base}/v1/health nicht erreichbar")
        return 1
    print(f"health: status={health.get('status')} native={health.get('native')} engine={health.get('engine')}")
    if health.get("status") != "alive" or health.get("native") is not True:
        print("FAIL: Fassade meldet nicht alive/native")
        return 1

    def put(path: str, body: dict) -> None:
        req = urllib.request.Request(
            base + path, data=json.dumps(body).encode(), method="PUT",
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            if r.status != 200:
                raise RuntimeError(f"PUT {path}: HTTP {r.status}")

    try:
        put("/v1/config/devices/batteries",
            {"battery1": {"device_id": "battery1", "capacity_wh": 10000}})
        put("/v1/config/devices/inverters",
            {"inverter1": {"device_id": "inverter1", "max_power_w": 5000, "battery_id": "battery1"}})
        with urllib.request.urlopen(base + "/v1/config", timeout=10) as r:
            devices = json.load(r)["devices"]
        battery = devices["batteries"]["battery1"]
        inverter = devices["inverters"]["inverter1"]
    except Exception as exc:  # noqa: BLE001 - jede Abweichung ist ein Fehlschlag
        print(f"FAIL: Konfiguration nicht wie erwartet ({exc})")
        return 1
    missing = [k for k, d in (("soc_value_steps", battery), ("max_grid_import_power_w", inverter)) if k not in d]
    if missing:
        print(f"FAIL: Kern meldet {', '.join(missing)} nicht (kein 0.2.0-Kern mit D/E?)")
        return 1
    print("OK: D/E-Felder vorhanden (soc_value_steps, max_grid_import_power_w)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
