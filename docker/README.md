# DVhub im Container (WS6)

Minimal-Laufzeitimage als gemeinsame Basis für die SPiNE-EnergyLink-App
(ARM64) und einen künftigen Home-Assistant-Add-on-Wrapper.

Konzept und Gesamtbild: `.planning/T-CONTAINER-STACK-KONZEPT-2026-07-01.md`.
Dieses Verzeichnis deckt dessen Roadmap-Punkte 1 und 2 ab (Dockerfile +
Entrypoint). `docker-compose.yml`, CI-Workflow und der Runtime-Guard für den
Update-Button stehen noch aus.

## Bauen

```bash
# nur die eigene Architektur
docker build -t dvhub:dev .

# beide Zielarchitekturen (benötigt buildx + QEMU/binfmt für Fremdarch)
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg VCS_REF="$(git rev-parse --short HEAD)" \
  -t ghcr.io/chloepriceless/dvhub:dev --push .
```

Der Build läuft aus dem **Repo-Wurzelverzeichnis**, nicht aus `docker/`.

## Betreiben

```bash
docker run -d --name dvhub \
  -e DVHUB_DB_HOST=timescaledb -e DVHUB_DB_USER=dvhub \
  -e DVHUB_DB_PASSWORD=... -e DVHUB_DB_NAME=dvhub \
  -v dvhub-config:/etc/dvhub -v dvhub-data:/var/lib/dvhub \
  -p 8080:8080 ghcr.io/chloepriceless/dvhub:dev
```

Beide Volumes sind **Pflicht**. `/var/lib/dvhub` trägt die `appliance-id`, an
die die Lizenz bindet — ohne Volume erzeugt jeder neue Container eine neue und
die Lizenzbindung bricht.

Für mDNS-Discovery (Victron, Shelly) und Modbus :502 im LAN braucht es
`--network host`; im Bridge-Netz funktioniert Multicast nicht (Konzept §3).

| Variable | Default | Zweck |
|---|---|---|
| `DVHUB_HTTP_PORT` | `8080` | Nur beim **ersten** Start in die Config geschrieben. Der ausgelieferte Default 80 ist für den non-root-Prozess nicht bindbar. |
| `DVHUB_DB_HOST/PORT/NAME/USER/PASSWORD` | – | Schreiben `telemetry.database.*`. Nötig, weil der ausgelieferte Default ein Unix-Socket (`/var/run/postgresql`) ist, den es im Container nicht gibt. Nur gesetzte Variablen wirken. |
| `DVHUB_WAIT_FOR_DB` | `1` | Wartet vor dem Start auf die DB. |
| `DVHUB_WAIT_FOR_DB_TIMEOUT` | `60` | Danach wird trotzdem gestartet. |
| `DVHUB_USER` | `dvhub` | Nutzer, auf den der Entrypoint die Rechte ablegt. |
| `DVHUB_APP_DIR` / `DVHUB_SCRIPTS_DIR` | `/opt/dvhub/…` | Nur für abweichende Layouts (Add-on-Wrapper, Testlauf). |

Der Entrypoint ist idempotent: Config wird nur angelegt, nie überschrieben;
`apiToken` und `appliance-id` nur erzeugt, wenn sie fehlen; Betreiber-Edits an
der Config bleiben stehen. Läuft der Container bereits unter einer
unprivilegierten UID (`--user`), überspringt er den `chown` und startet direkt.

## Bewusst NICHT enthalten

* **Postgres/TimescaleDB** — eigener Container bzw. externer Host.
* **Python-Forecast und ML** — würden das Image vervielfachen; der EnergyLink
  hat ~1 GB RAM / ~2,3 GB Disk. Die Node-seitige `services/python-bridge/`
  ist drin (sie wird von `server.js` statisch importiert), nur der Interpreter
  fehlt.
* **EOS (Pro)** — eigenes Image aus dem DV-EOS-Fork.
* **VPN und Support-Tunnel** — v1 nativ-only.
* **git** — im Container wird nicht per `git pull` aktualisiert, sondern das
  Image getauscht. Der Update-Button im Backend kennt diesen Fall noch nicht;
  das Image setzt `DVHUB_RUNTIME=container` als Haken für den späteren Guard.

## Verifikationsstand (2026-08-27)

Gebaut und gefahren auf einem Docker-Host im LAN (Docker 29.7.2, buildx 0.36.1):

* Build **amd64 und arm64** erfolgreich (`docker buildx --platform
  linux/amd64,linux/arm64`), ~338 MB je Architektur.
* **amd64**: Container `healthy`, Migrationen 001–020 gegen Postgres 16
  durchgelaufen, `/api/status` 200 in ~110 ms.
* **arm64** unter QEMU: `healthy`, `uname -m` = `aarch64`, `process.arch` =
  `arm64`, `/api/status` 200 (~1,2 s — Emulations-Overhead).
* PID 1 läuft als `dvhub`, nicht als root.
* Container gelöscht und aus denselben Volumes neu erzeugt: `appliance-id`
  identisch, Config unverändert — Lizenzbindung übersteht den Image-Tausch.
* Im Image: **0** Testdateien, kein `git`, `Europe/Berlin` löst korrekt auf
  (ohne das `tzdata`-Paket fiele Alpine still auf UTC zurück).

Zusätzlich auf **echter ARM-Hardware** (Raspberry Pi 4 Model B, Debian 13,
1,8 GB RAM) nachgezogen:

* **Nativer arm64-Build** (kein QEMU) in **70 s**, Image 335 MB.
* Container `healthy`, Migrationen 001–020 gegen Postgres 16 durch, PID 1 als
  `dvhub`, `/api/status` 200 in **~0,36 s** (gegen ~1,2 s emuliert und ~0,11 s
  auf amd64).
* `appliance-id` überlebt auch hier die Neuerzeugung des Containers.

Damit ist der EnergyLink-Zielarch nicht nur emuliert, sondern auf echter
ARM64-Hardware belegt. Der Pi ist mit ~1 GB freiem RAM durch Build und Betrieb
gekommen, ohne die parallel laufende native DVhub-Installation zu stören.

Nicht geprüft: mDNS-Discovery und Modbus unter `--network host`, der
Onboarding-Assistent über die Weboberfläche, Betrieb auf dem EnergyLink selbst
(~1 GB RAM / ~2,3 GB Disk — enger als der Pi).
