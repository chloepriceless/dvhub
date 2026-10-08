# DVhub im Container (WS6)

Minimal-Laufzeitimage als gemeinsame Basis für die SPiNE-EnergyLink-App
(ARM64) und einen künftigen Home-Assistant-Add-on-Wrapper.

Inhalt dieses Verzeichnisses:

| Datei | Zweck |
|---|---|
| `../Dockerfile`, `docker-entrypoint.sh` | Image + idempotenter Start (Config, appliance-id, Profile, DB-Warten, Heap) |
| `install.sh` | Einzeiler-Installation: Ordner, `compose.yml`, `.env` mit Zufallspasswörtern, Images, Start |
| `compose.yml`, `.env.example` | DVhub + TimescaleDB (PostgreSQL 17) + EOS; die DB-Ersteinrichtung (Rolle `dvhub`, DB `dvhub`, Extension `timescaledb`) steckt als `configs` darin |
| `../.github/workflows/container.yml` | Smoke-Test mit Compose, dann Build amd64+arm64 → Docker Hub `bikinibottomcapital/dvhub` + `…/dvhub-eos` (gespiegelt nach GHCR) |

## Schnellstart

```bash
curl -fsSL https://raw.githubusercontent.com/chloepriceless/dvhub/main/docker/install.sh | bash
# Optionen: bash -s -- --no-eos | --tag dev | --dir /opt/dvhub | --port 8090
```

Voraussetzung: Docker mit Compose ≥ 2.23 (die DB-Einrichtung steckt als
`configs.content` in `compose.yml`). Der Einzeiler ist wiederholbar: `.env`
(Passwörter) und Daten bleiben, `compose.yml` und die Images werden erneuert.

Von Hand, im Repo:

```bash
git clone https://github.com/chloepriceless/dvhub.git && cd dvhub
cp docker/.env.example docker/.env      # DB_ADMIN_PASSWORD + DVHUB_DB_PASSWORD setzen
docker compose -f docker/compose.yml --env-file docker/.env up -d
```

Danach `http://<host>:8080`. DVhub läuft im Host-Netz (Modbus zur Anlage,
DV-Modbus-Server :1502, mDNS-Discovery); die DB ist nur auf `127.0.0.1:5433`
erreichbar. Beim ersten Start legt die DB die App-Rolle `dvhub` an (kein
Superuser) und aktiviert TimescaleDB; DVhub wartet auf die DB und spielt seine
Migrationen ein.

Den API-Token (für Skripte und den DB-Restore) zeigt:

```bash
docker compose -f docker/compose.yml exec dvhub node -p 'require("/etc/dvhub/config.json").apiToken'
```

### Images und Tags

| Image | Tags |
|---|---|
| `bikinibottomcapital/dvhub` | `latest`, `1.0`, `1.0.7` = Releases; `dev` = Vorab-Stand (von Hand gebaut, kein Release) |
| `bikinibottomcapital/dvhub-eos` | EOS-Stand, z. B. `dvhub-v0.4.0rc1.18` (= `EOS_TAG`), `latest` = der des letzten Releases |

Beide für `linux/amd64` und `linux/arm64`, auf Docker Hub öffentlich und nach
`ghcr.io/chloepriceless/…` gespiegelt (`DVHUB_IMAGE`/`EOS_IMAGE` in `.env`).
Bis zum ersten Release gibt es nur `dev` — dann `DVHUB_TAG=dev` in `.env`.

### Release veröffentlichen

Images entstehen **nur** bei einem Release-Tag (Workflow `container.yml`);
Pushes auf `main` bauen kein Image.

```bash
# 1. Version in dvhub/package.json anheben (z. B. 1.0.7), CHANGELOG-Eintrag
# 2. committen, pushen, dann taggen:
git tag v1.0.7 && git push origin v1.0.7
```

Der Workflow prüft, dass der Tag zur `package.json`-Version passt, startet die
Suite mit TimescaleDB (Health, Migrationen, Backup-Download, Update-Sperre,
kein root) und veröffentlicht erst danach `1.0.7`, `1.0` und `latest` für
amd64 + arm64 auf Docker Hub und GHCR. Voraussetzung im GitHub-Repo
(Settings → Secrets and variables → Actions): ein Secret `BIKINIBOTTOMCAPITAL`
(oder `DOCKERHUB_TOKEN`) mit dem Docker-Hub-Access-Token (Read & Write) — ohne
es bricht der Lauf vor dem Bauen ab. Der Benutzername steht im Workflow.

### Speicherbudget der Suite

Die Obergrenzen (`mem_limit`) ergeben zusammen **672 MB** (Stand 2026-10-02):

| Container | Obergrenze | gemessen (echte Prod-Daten) |
|---|---|---|
| DB | 224 MB (`shared_buffers` 64 MB, 3 DVhub-Verbindungen) | Betrieb ~110–120 MB; ein voller Restore braucht mehr — mit 160 MB wurde er auf x86 abgebrochen |
| DVhub | 192 MB | max ~130–150 MB (Bedienung + Wohnzimmer-Tablet gleichzeitig) |
| EOS | 320 MB | DV-EOS rc1.6, Fitness-Cache aus: ~150–155 MB Prozessspeicher, ~217 MB inkl. Bibliotheken — auch beim Planen mit E-Auto und Geräten. rc1.8 mit 2 Rechenprozessen (eHive One, 300×200): Spitze 224 MB, Leerlauf 128 MB |

Die Historie rechnet Jahr und „Alle“ Monat für Monat — der Speicher folgt dem
größten Monat, nicht der Länge der Historie. Mehr RAM vorhanden: die Werte in
`.env` großzügiger setzen.

## Aktualisieren

Im Container wird nicht per `git` aktualisiert, sondern das Image getauscht:

```bash
docker compose -f docker/compose.yml --env-file docker/.env pull
docker compose -f docker/compose.yml --env-file docker/.env up -d
```

**Neue `compose.yml` mitnehmen.** `pull` tauscht nur die Images. Ändert sich
die Suite selbst (z. B. Datenbank-Einstellungen für SD-Karten und große
Restores, 2026-10-01), holt der Installer sie neu — `.env` (Passwörter) und
die Daten bleiben:

```bash
curl -fsSL https://raw.githubusercontent.com/chloepriceless/dvhub/main/docker/install.sh | bash -s -- --dir <installationsordner>
```

Config und Daten bleiben in den Volumes. Die Knöpfe „Update“, „System-Updates“,
„Neustart“, „Reboot“ und „TimescaleDB aktualisieren“ antworten im Container mit
genau diesem Hinweis (HTTP 409, `code: container_runtime`) statt git/apt/systemd
aufzurufen. Die TimescaleDB-Version hebt man über `TIMESCALE_TAG` in `.env`
(gleiche PostgreSQL-Hauptversion; danach einmal
`docker compose exec db psql -U postgres -d dvhub -c 'ALTER EXTENSION timescaledb UPDATE'`).

## Bestandsdaten übernehmen (native Installation → Container)

**Einfachster Weg (ab 2026-10-01): voller Export + DB-Backup.** Auf der alten
Anlage *Einstellungen → Export → „Mit Geheimnissen (Passwort)“* und
*Status → Datenbank-Backup*; im Container *Import* (Frage „Geräte-Tausch?“ mit
**Ja** beantworten) und *Datenbank wiederherstellen*, danach den Container neu
starten. Der volle Export trägt Lizenz, Geräte-Kennung, API-Token,
Datenspende-, Portal-, TLS- und VPN-Schlüssel — die alte Anlage danach nicht
mehr parallel betreiben. Der Weg von Hand:

Eine laufende Anlage bringt drei Dinge mit: **Config**, **Datenverzeichnis**
(u. a. `appliance-id` — daran hängt die Pro-Lizenz — Push-Schlüssel,
Datenspende-Zugang, Installateurs-Portal-Schlüssel) und die **Datenbank**.

**1. Auf der alten Anlage sichern**

```bash
# Datenbank — vollständig, als postgres (auch postgres-eigene Tabellen)
sudo -u postgres pg_dump -Fc dvhub > dvhub-full.dump
# oder in der Oberfläche: Einstellungen → Status → DB-Backup → Vollständig

# Config + Datenverzeichnis
sudo tar czf dvhub-state.tgz -C / etc/dvhub var/lib/dvhub
```

Danach den nativen Dienst stoppen (`sudo systemctl disable --now dvhub`),
wenn der Container auf **demselben** Host laufen soll — beide wollen dieselben
Ports (Web, Modbus :1502).

**2. Config + Datenverzeichnis in die Volumes legen** (vor dem ersten Start):

```bash
docker compose -f docker/compose.yml --env-file docker/.env create
docker run --rm -v dvhub_dvhub-config:/etc/dvhub -v dvhub_dvhub-data:/var/lib/dvhub \
  -v "$PWD":/in alpine tar xzf /in/dvhub-state.tgz -C /
docker compose -f docker/compose.yml --env-file docker/.env up -d
```

Der Entrypoint passt die mitgebrachte Config an den Container an: DB-Verbindung
aus `DVHUB_DB_*` (TCP statt Unix-Socket), TimescaleDB-Flag, und Ports unter 1024
(nativ 80/443) auf 8080/8443 — der Prozess läuft ohne root. Alles andere
(Anlage, Tarife, Zeitpläne, Integrationen, API-Token) bleibt, wie es war.

**3. Datenbank einspielen**

```bash
TOKEN=$(docker compose -f docker/compose.yml exec -T dvhub node -p 'require("/etc/dvhub/config.json").apiToken')
curl -H "Authorization: Bearer $TOKEN" -H 'content-type: application/octet-stream' \
     --data-binary @dvhub-full.dump http://127.0.0.1:8080/api/db/restore
docker compose -f docker/compose.yml --env-file docker/.env restart dvhub
```

Oder in der Oberfläche: Einstellungen → Status → DB-Backup → Wiederherstellen
(verlangt den API-Token). Der Restore läuft als DB-Admin `postgres`: er sperrt
die App währenddessen aus, erledigt die TimescaleDB-Schritte
(`timescaledb_pre_restore`/`post_restore`, Versionsabgleich), behält die
Eigentümer und Rechte der Tabellen 1:1 bei. Rollen der alten Anlage, die es im
Container nicht gibt (z. B. `grafana`), legt er vorher ohne Login-Recht an.
Die Antwort meldet `ignoredErrors` — `0` heißt sauber.

Hinweise:

* **Versionen:** Der Dump sollte von derselben oder einer älteren
  TimescaleDB-Version stammen als der DB-Container (Appliances: PostgreSQL 17 +
  TimescaleDB 2.28.x = `TIMESCALE_TAG=2.28.2-pg17`). Eine ältere Quelle wird
  beim Restore hochgezogen; eine neuere geht nicht.
* **Größe:** Der Upload wird im Container unter `/tmp` zwischengespeichert
  (bis 8 GB). Ein 7-GB-Bestand ergibt einen deutlich kleineren Dump, braucht
  aber entsprechend freien Platz im Container-Dateisystem und einige Zeit.
* **Probe vorher:** Gleicher Ablauf mit einem Dump nur der 15-Minuten-Werte
  (`?scope=energy15m` bzw. „Nur 15-min-Werte“) geht in Sekunden.

## DB-Backup im Container

Download und geplantes Backup funktionieren wie auf der Appliance: das Image
enthält den PostgreSQL-17-Client, DVhub verbindet sich per TCP als DB-Admin
(`DVHUB_DB_ADMIN_USER`/`DVHUB_DB_ADMIN_PASSWORD`, im Compose `postgres`).
Als Ziel für das geplante Backup ein Verzeichnis im Volume
(`/var/lib/dvhub/backups`) oder einen eingehängten Pfad (`/backups`, siehe
`compose.yml`) eintragen. SMB-Ziele brauchen `smbclient` — der ist nicht im
Image; einen Share stattdessen im Host-OS mounten und einhängen.

## Bauen

```bash
# nur die eigene Architektur
docker build -t dvhub:dev .

# beide Zielarchitekturen (benötigt buildx + QEMU/binfmt für Fremdarch)
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg VCS_REF="$(git rev-parse --short HEAD)" \
  -t bikinibottomcapital/dvhub:dev --push .
```

Der Build läuft aus dem **Repo-Wurzelverzeichnis**, nicht aus `docker/`.

## Betreiben ohne Compose

> Stolperstein bei einer **TimescaleDB im Container auf Hosts ohne
> cgroup-Memory** (z. B. Raspberry Pi mit Standard-Kernel, `cgroup_enable=memory`
> nicht gesetzt): das Tuning-Skript des `timescale/timescaledb`-Images stürzt
> mit `panic: bytes must be at least 1 byte` ab und der DB-Container beendet
> sich (Exit 2) — DVhub wartet dann 60 s und startet ohne Store. Abhilfe:
> `-e NO_TS_TUNE=true` am DB-Container (oder cgroup-Memory im Kernel aktivieren).
> `compose.yml` umgeht das, indem es `TS_TUNE_MEMORY` fest vorgibt.

```bash
docker run -d --name dvhub \
  -e DVHUB_DB_HOST=timescaledb -e DVHUB_DB_USER=dvhub \
  -e DVHUB_DB_PASSWORD=... -e DVHUB_DB_NAME=dvhub \
  -v dvhub-config:/etc/dvhub -v dvhub-data:/var/lib/dvhub \
  -p 8080:8080 bikinibottomcapital/dvhub:dev
```

Beide Volumes sind **Pflicht**. `/var/lib/dvhub` trägt die `appliance-id`, an
die die Lizenz bindet — ohne Volume erzeugt jeder neue Container eine neue und
die Lizenzbindung bricht.

Für mDNS-Discovery (Victron, Shelly) und Modbus :502 im LAN braucht es
`--network host`; im Bridge-Netz funktioniert Multicast nicht (Konzept §3).

| Variable | Default | Zweck |
|---|---|---|
| `DVHUB_HTTP_PORT` | `8080` | Beim **ersten** Start in die Config geschrieben; außerdem Ersatz, wenn eine mitgebrachte Config einen Port < 1024 hat. Der ausgelieferte Default 80 ist für den non-root-Prozess nicht bindbar. |
| `DVHUB_HTTPS_PORT` | `8443` | Ersatz für einen mitgebrachten `httpsPort` < 1024. |
| `DVHUB_DB_HOST/PORT/NAME/USER/PASSWORD` | – | Schreiben `telemetry.database.*`. Nötig, weil der ausgelieferte Default ein Unix-Socket (`/var/run/postgresql`) ist, den es im Container nicht gibt. Nur gesetzte Variablen wirken. |
| `DVHUB_DB_TIMESCALEDB` | – | `true` setzt `telemetry.database.timescaledb` — erst damit laufen die TimescaleDB-Migrationen (Hypertable, Continuous Aggregates, Kompression). |
| `DVHUB_DB_ADMIN_USER` / `DVHUB_DB_ADMIN_PASSWORD` | `postgres` / – | DB-Admin für Backup-Download, geplantes Backup und Restore. Ohne Passwort antworten Backup/Restore mit `db_admin_missing`. |
| `DVHUB_PG_BIN_DIR` | `/usr/libexec/postgresql17` | Ort von `pg_dump`/`pg_restore`/`psql` im Image. |
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

* **Postgres/TimescaleDB** — eigener Container (`compose.yml`) bzw. externer
  Host; im Image liegt nur der Client für Backup/Restore.
* **Python-Forecast und ML** — würden das Image vervielfachen; der EnergyLink
  hat ~1 GB RAM / ~2,3 GB Disk. Die Node-seitige `services/python-bridge/`
  ist drin (sie wird von `server.js` statisch importiert), nur der Interpreter
  fehlt.
* **EOS (Pro)** — eigenes Image aus dem DV-EOS-Fork.
* **VPN:** OpenVPN und WireGuard zum Direktvermarkter laufen im DVhub-Container (Rechte `NET_ADMIN` + `/dev/net/tun`, in `compose.yml` gesetzt; WireGuard nutzt das Kernelmodul des Hosts). IPsec und der Support-Tunnel weiterhin nur nativ.
* **git** — im Container wird nicht per `git pull` aktualisiert, sondern das
  Image getauscht (siehe „Aktualisieren“); die Update-Knöpfe sagen das.
* **smbclient** — SMB-Backup-Ziele im Host-OS mounten und einhängen.

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
