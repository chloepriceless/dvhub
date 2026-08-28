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
| `DVHUB_AUTO_HEAP` | `1` | Leitet `--max-old-space-size` aus dem cgroup-Limit ab (70 %). `0` schaltet ab. |
| `NODE_OPTIONS` | – | Ein eigenes `--max-old-space-size` hat Vorrang vor der Automatik. |

## Speicher begrenzen (EnergyLink: ~700 MB für DVhub **und** EOS)

**Node richtet seinen Heap nicht nach dem Container-Limit.** Gemessen meldet es
bei `--memory=96m` dasselbe `heap_size_limit` (259 MB) wie bei `--memory=320m`.
Ohne Deckel wächst der Heap über die Containergrenze hinaus und der Prozess
wird vom OOM-Killer erschlagen, statt vorher aufzuräumen.

Der Entrypoint löst das: er liest das cgroup-Limit und setzt daraus **70 %** als
`--max-old-space-size`. Gemessen:

| `--memory` | abgeleiteter Heap | Verbrauch idle | Status |
|---|---|---|---|
| 512m | 358 MB | ~42 MiB | healthy |
| 320m | 224 MB | ~42 MiB | healthy |
| 256m | 179 MB | ~42 MiB | healthy |
| 192m | 134 MB | ~40 MiB | healthy |

Ohne `--memory` wird **kein** Deckel gesetzt (Heap bleibt bei Nodes Default) —
so bleibt das Image für den HA-Add-on-Fall auf einer großen Box unbeschränkt.
Ein selbst gesetztes `--max-old-space-size` in `NODE_OPTIONS` gewinnt immer;
`DVHUB_AUTO_HEAP=0` schaltet die Automatik ganz ab.

> **Einschränkung:** Die Automatik braucht cgroup-Memory-Accounting. Auf
> Raspberry Pi OS fehlt es standardmäßig (`cgroup_enable=memory` nicht in
> `cmdline.txt`) — dort greift weder `--memory` noch die Ableitung. Wenn
> unklar ist, ob die Zielplattform es hat, `NODE_OPTIONS` explizit setzen.

**Empfehlung für den EnergyLink** (~700 MB für DVhub + EOS zusammen):

```bash
docker run -d --memory=256m --memory-swap=256m ...   # DVhub: Heap wird 179 MB
```

Das lässt rund 440 MB für EOS und System.

### Lasttest mit echten Produktivdaten

`--memory=256m`, Datenbank aus einem prod-Dump (3,06 Mio Telemetriezeilen,
2,74 Mio `optimizer_run_series`, 1,03 Mio `energy_slots_15m`), echte
Betriebs-Config:

| Situation | Verbrauch (von 256 MB) |
|---|---|
| Start, Config + Store geladen | 168 MiB |
| eingeschwungen nach GC | 62–78 MiB |
| `history/summary` + `raw`, 7d bis 365d | 68–78 MiB |
| 10 parallele `raw`-Abfragen über 90d | 70 MiB |
| CSV-Export 365d (180 MB Ausgabe) | 102 MiB |
| **Parquet-Export 365d (203 MB Ausgabe), Peak** | **136 MiB** |

Kein OOM-Kill, keine Neustarts, durchgehend `healthy`. Der Startwert von
168 MiB fällt nach der ersten Garbage Collection auf unter 80 MiB — genau das
Verhalten, das der Heap-Deckel erzwingen soll: Node räumt auf, bevor es an die
Containergrenze stößt. Die Streaming-Exporte (pg-cursor, Parquet) halten ihr
Versprechen — 200 MB Ausgabe bei 136 MiB Verbrauch.

**Gegenrechnung fürs 700-MB-Budget** (Messwerte einer echten Box, Peak über
5 Minuten mit laufenden Optimierungsläufen): EOS 49 MB, EOS-Dash 21 MB,
DVhub-Container 136 MiB Peak — zusammen **rund 210 MB**. Mit `--memory=256m`
für DVhub plus großzügig 128m für EOS bleibt man bei ~384 MB und damit
deutlich unter 700 MB. `192m` für DVhub wäre nach diesen Zahlen noch tragfähig
(Peak 136 MiB), lässt aber kaum Reserve für den Parquet-Export.

Der Entrypoint ist idempotent: Config wird nur angelegt, nie überschrieben;
`apiToken` und `appliance-id` nur erzeugt, wenn sie fehlen; Betreiber-Edits an
der Config bleiben stehen. Läuft der Container bereits unter einer
unprivilegierten UID (`--user`), überspringt er den `chown` und startet direkt.

## Datenhaltung: gestufte Retention (Messung an Produktivdaten)

Der EnergyLink hat ~2,3 GB Disk — die aktuelle „keep forever"-Policy passt dort
nicht. Gemessen an einer echten Produktivkopie (69.153.918 Zeilen in
`timeseries_samples`) mit der Staffelung **raw 3 Tage / 1 min 2 Monate /
15 min dauerhaft**:

| | Zeilen | Größe (komprimiert) |
|---|---|---|
| vorher | 69.153.918 | 1671 MB |
| nachher | 2.047.977 | **27 MB** |

Also **2,96 % der Zeilen** und **1,6 % des Platzes**. Der Löwenanteil sind
61,3 Mio Zeilen im 5-Sekunden-Takt; die 15-Minuten-Serie reicht bereits bis
Mai 2025 zurück.

Drei Punkte, die eine Umsetzung beachten muss — alle am Datenbestand belegt:

1. **Vorher aggregieren, sonst Datenverlust.** Von 43 Serien mit Rohdaten
   existieren **26 ausschließlich als Rohdaten** — darunter `grid_l1_w`,
   `grid_l2_w`, `grid_l3_w`, `grid_total_w`, `grid_setpoint_w`, die AC-PV-Phasen
   und alle `tesla_*`. Ein reines Löschen nach 3 Tagen vernichtet sie ersatzlos.
2. **`drop_chunks()` ist hier nicht nutzbar.** Alle Auflösungen liegen in
   *derselben* Hypertable (67 Chunks, 65 komprimiert). Zeitbasierte
   Chunk-Retention kann Rohdaten und 15-Minuten-Daten nicht trennen. Entweder
   getrennte Hypertables je Auflösung — dann greift `drop_chunks` wieder — oder
   zeilenweises Löschen mit Dekompression (teuer).
3. **Textserien brauchen `last()`, nicht `avg()`.** `tesla_display_name`,
   `tesla_geofence` und `tesla_since` führen ausschließlich `value_text`; eine
   Mittelwert-Aggregation lässt sie stillschweigend verschwinden.

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
