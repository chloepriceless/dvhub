# DVhub-EOS im local-native-Modus (Docker)

Fährt den EOS-Dienst mit dem eigenständigen Rust-Binär **`dvhub-optimize serve`**
statt mit Python-EOS. Das Binär (dvhub-rs, `crates/eos-genetic`) bildet die
**EOS v0.4.0rc3 HTTP-Schnittstelle** nach und rechnet `POST /v1/optimize`
synchron. Es ist paritätsbewiesen gegen Python-EOS (P1 40419/40419, P2 32/32
bitgleich, E2E 6/6). Weil HTTP-gleich, bleibt die DVhub-Seite
(`services/optimizer/eos-adapter.js`, `eos-run-trigger.js`, `eos-monitor.js`)
**unverändert** — `resolveEosProxy()` behält bei `mode=local-native` dieselbe
lokale URL/den Port `:8503`.

Nutzen: **−170..−230 MB RAM** gegenüber dem Python-EOS-Container.

## Image

- Rezept: `docker/eos-localnative/` (`Dockerfile` + `docker-bake.hcl`).
- Base: `python:3.13-slim` — Python bleibt **nur** für den unveränderten
  EOS-Wächter (`configs: dvhub-eos-watch`, ein stdlib-Prozess), der EOS neu
  startet, wenn DVhub es anfordert. Das Binär selbst ist statisch (musl), ~3 MB,
  braucht keine weiteren Abhängigkeiten.
- Das Binär wird beim Bau als Build-Kontext `bins` gemountet (wie
  `docker/eos-native` die Wheels), nach `uname -m` ausgewählt und seine
  **sha256 gegen `eos-version.env` hart geprüft** (Bau scheitert bei Abweichung).
- Image: `bikinibottomcapital/dvhub-eos-localnative:<EOS_NATIVE_BIN_VERSION>`.

### Bauen (multi-arch)

Aus dem Repo-Wurzelordner:

```sh
BINS_DIR=$(mktemp -d)
scripts/eos-native-wheels.sh fetch "$BINS_DIR" AARCH64 X86_64 --prefix EOS_NATIVE_BIN
export $(grep -E '^EOS_NATIVE_BIN_[A-Z0-9_]+=' eos-version.env | xargs)
BINS_DIR=$BINS_DIR TAGS=bikinibottomcapital/dvhub-eos-localnative:0.1.0-dev2611152231 \
  docker buildx bake --allow=fs.read="$BINS_DIR" \
    -f docker/eos-localnative/docker-bake.hcl [--push|--load] dvhub-eos-localnative
```

`--allow=fs.read=$BINS_DIR` ist nötig, weil der `bins`-Kontext außerhalb des
Build-Kontexts liegt. `--load` lädt genau eine Architektur ins lokale Docker,
`--push` veröffentlicht die Multi-Arch-Liste.

## Umstellung des Stacks auf local-native

Überlagerungs-Datei `docker/compose.eos-localnative.yml` zusätzlich zu
`docker/compose.yml` angeben (Reihenfolge wichtig, Basis zuerst):

```sh
docker compose -f docker/compose.yml -f docker/compose.eos-localnative.yml \
  --profile eos up -d
```

Das ersetzt nur Image, `command` (Wächter → `dvhub-optimize serve` als Kind) und
`mem_limit` (Vorgabe **160m** statt 320m). Alles andere (Host-Netz, Volumes,
Wächter-Mount, `restart:`) kommt aus der Basis.

### Rückweg zu Python-EOS

Die Überlagerungs-Datei einfach **weglassen**:

```sh
docker compose -f docker/compose.yml --profile eos up -d
```

Es gilt wieder der Standard-Dienst aus `compose.yml` (Python-EOS). Es ist kein
weiterer Schritt nötig.

## Zustand (Volume `dvhub-eos:/data`)

Beide Dienste nutzen **dasselbe `--state-dir /data`**. Der Fassaden-Zustand
(letztes Ergebnis/Plan/Lösung für Warmstart, `PUT /v1/config/file`) überdauert
Neustart und Umstieg. DVhub pusht Config, Messwerte und Prognosen bei jedem Lauf
ohnehin neu über die EOS-HTTP-Schnittstelle (`:8503`) — ein Wechsel hin oder
zurück braucht keine Daten-Migration. (Die Zustandsformate von Python-EOS und
Fassade sind nicht identisch; da DVhub den Zustand bei jedem Lauf neu setzt, ist
das unerheblich. Wer ganz sauber starten will, kann das Volume vor dem Umstieg
leeren — nicht nötig.)

## Neustart aus DVhub

„EOS neu starten" (hängender Lauf / Knopf) wirkt unverändert: der **gleiche**
Python-Wächter (`configs: dvhub-eos-watch`) fragt DVhub minütlich
(`GET /api/eos/restart-request`); bei einer Anforderung beendet er den
Kindprozess (`dvhub-optimize serve`) und endet mit 75 — Docker startet den
Container per `restart:` neu. Verifiziert im Rauchtest (Container-Exit 75, Kind
beendet).

## Wichtig: Docker-Opt-in statt `eos-provision.sh`

DVhub kennt `optimizer.eosProxy.mode = local-native` (config-model.js). Im
**nativen/systemd-Betrieb** schaltet `eos-provision.sh` nur bei gesetztem
Opt-in-Marker (`/etc/dvhub-release/eos-native-optin`) auf das Binär um. Im
**Docker-Stack greift dieser Marker nicht** — die Umstellung läuft allein über
die Compose-Überlagerung (Image + `command`). DVhub-seitig ist nichts zu ändern:
`resolveEosProxy()` liefert bei `mode=local-native` dieselbe URL/den Port `:8503`
wie bei `local` (nur `mode` unterscheidet sich; `url`, Port, Timeout identisch).
Man kann `optimizer.eosProxy.mode` in der Oberfläche auf `local-native` stellen,
muss es für den Docker-Betrieb aber nicht — der Adapter spricht so oder so `:8503`.
