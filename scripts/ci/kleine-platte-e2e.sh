#!/usr/bin/env bash
# scripts/ci/kleine-platte-e2e.sh — End-to-End-Test „kleine Platte“ für die
# Speicher-Überwachung (Konzept .planning/konzept/2026-11-23-speicher-ueberwachung.md,
# Schritt 7). Anlass 23.11.2026: Kundenbox mit Debian auf 12-GB-Platte, ~6 GB frei,
# Datenbank lief ohne Kompression voll.
#
# Was passiert: Für jedes Szenario legt der Test in der Colima-VM ein echtes
# ext4-Dateisystem fester Größe an (Loop-Datei, sparse), startet darauf den
# Docker-Stack aus docker/compose.yml DES GEPRÜFTEN STANDS (DB + DVhub, DVhub aus
# dem Stand gebaut), füllt die Datenbank mit synthetischer Telemetrie, stellt mit
# einer Füll-Datei einen Ziel-Füllstand ein und lässt die Speicher-Wache laufen.
# statfs liefert dabei echte Werte. Danach wird alles wieder abgebaut.
#
#   1  Community-TimescaleDB, 12 GB, ~6 GB frei      → Profil klein, Kompression aktiv
#   2  Apache-TimescaleDB,   12 GB, ~8 % frei        → rote Warnung, Wache bricht nicht ab,
#                                                      5-s-Rohwerte nach Profil entfernt
#   3  reines PostgreSQL,    12 GB, ~8 % frei        → wie 2 (portionsweise Löschung), kein Absturz
#   4  Community, winzige 4-GB-Platte, ~4 % frei     → Stufen greifen, Hinweis + Push,
#                                                      Preise/15-min bleiben
#   5  Community, PG-Daten auf eigener 6-GB-Platte (~4 % frei), DVhub-Daten auf
#      2-GB-Platte (~15 % frei)                      → Wache misst die PG-Platte, warnt für beide
#
# Aufruf (Mac, Colima läuft):
#   scripts/ci/kleine-platte-e2e.sh                         # prüft den Stand dieses Worktrees
#   scripts/ci/kleine-platte-e2e.sh --worktree ~/Projects/DVhub-int
#   scripts/ci/kleine-platte-e2e.sh --ref integration/2026-11-24 --scenarios 2,3
# Optionen:
#   --worktree PATH   Stand aus diesem Verzeichnis (Standard: Repo dieses Skripts)
#   --ref REF         Stand aus diesem Git-Ref (temporärer Worktree, wird entfernt)
#   --scenarios LIST  z. B. 1,2,5 (Standard: 1,2,3,4,5)
#   --out DIR         Ergebnisordner (Standard: <scratch>/kleine-platte-<zeit>)
#   --days N          Tage synthetische Telemetrie (Standard 45)
#   --step S          Abstand der Live-Werte in s (Standard 60 = 1/12 der Prod-Dichte,
#                     ~2,8 Mio. Zeilen / ~1 GB roh in 45 Tagen; 30 verdoppelt die
#                     Einspielzeit auf ~4,5 min je Szenario; 5 = Prod-Dichte, passt nur
#                     mit wenigen Tagen auf die kleinen Platten)
#   --keep-image      gebautes DVhub-Image behalten (dvhub-kp-e2e:<run>)
# Umgebung: DOCKER_HOST (Standard Colima), KP_TIMESCALE_TAG (2.30.2-pg17),
#   KP_PLAIN_PG_IMAGE (postgres:17-alpine), KP_SHIM_FIRST_MS / KP_SHIM_INTERVAL_MS
#   (Wache: erster Lauf / Takt, Standard 20 s / 45 s), KP_HTTP_PORT (18399),
#   KP_DB_PORT (15499), KP_CAPTURE_PORT (18398), KP_INSERT_WORKERS (3 parallele
#   psql-Sitzungen beim Einspielen), KP_SHIM_MATCH (welche Dateien beschleunigt werden).
#
# Ergebnis: <out>/summary.json (maschinenlesbar) und <out>/summary.txt (Tabelle),
# je Szenario <out>/s<N>/result.json mit allen Prüfungen und Belegen.
# Exit-Code: 0 alles grün, 1 mindestens ein Szenario rot, 2 Testaufbau gescheitert.
#
# Aufräumen (immer, auch bei Abbruch): Compose-Projekte samt Volumes, Mitschnitt-
# Container, Loop-Mounts und -Dateien, die selbst gebauten Images und nur die
# Basis-Images, die dieser Lauf selbst gezogen hat. Nichts anderes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KP="$HERE/kleine-platte"
REPO="$(cd "$HERE/../.." && pwd)"
WORKTREE=""; REF=""; SCENARIOS="1,2,3,4,5"; OUT=""; KEEP_IMAGE=0; DAYS=45; STEP=60
while [[ $# -gt 0 ]]; do
  case "$1" in
    --worktree) WORKTREE="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --scenarios) SCENARIOS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --days) DAYS="$2"; shift 2 ;;
    --step) STEP="$2"; shift 2 ;;
    --keep-image) KEEP_IMAGE=1; shift ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "unbekannte Option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$WORKTREE" && -n "$REF" ]] && { echo "--worktree und --ref schließen sich aus" >&2; exit 2; }
# Die Wache entfernt Rohwerte in Stufen bis 30 Tage; das Prüffenster der Stufen liegt
# zwischen 32 Tagen und dem Beginn der Historie — darunter ist nichts zu prüfen (Codex bec0888a).
[[ "$DAYS" =~ ^[0-9]+$ ]] && (( DAYS >= 36 )) || { echo "--days muss ≥ 36 sein (Rohwerte älter als 30 Tage + Prüffenster)" >&2; exit 2; }
[[ "$STEP" =~ ^[0-9]+$ ]] && (( STEP >= 5 && STEP <= 900 )) || { echo "--step muss 5…900 s sein" >&2; exit 2; }

export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}"
NODE="node"; [[ -x /opt/homebrew/opt/node@22/bin/node ]] && NODE=/opt/homebrew/opt/node@22/bin/node
TS_TAG="${KP_TIMESCALE_TAG:-2.30.2-pg17}"
PLAIN_PG_IMAGE="${KP_PLAIN_PG_IMAGE:-postgres:17-alpine}"
CAPTURE_IMAGE="${KP_CAPTURE_IMAGE:-node:22-bookworm-slim}"
HTTP_PORT="${KP_HTTP_PORT:-18399}"
DB_PORT="${KP_DB_PORT:-15499}"
CAPTURE_PORT="${KP_CAPTURE_PORT:-18398}"
export KP_SHIM_FIRST_MS="${KP_SHIM_FIRST_MS:-20000}"
export KP_SHIM_INTERVAL_MS="${KP_SHIM_INTERVAL_MS:-45000}"
[[ "$HTTP_PORT" == 18099 ]] && { echo "Port 18099 ist tabu (fremder Dienst)" >&2; exit 2; }

RUN_ID="kp$(date +%m%d%H%M%S)"
SCRATCH_DEFAULT="${TMPDIR:-/tmp}"
OUT="${OUT:-$SCRATCH_DEFAULT/kleine-platte-$RUN_ID}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
LOG="$OUT/run.log"
VM_IMG_DIR="/var/lib/kp-e2e/$RUN_ID"
VM_MNT_DIR="/mnt/kp-e2e/$RUN_ID"
VM_SHIM_DIR="$VM_MNT_DIR/shim"

say()  { printf '\n== %s\n' "$*" | tee -a "$LOG"; }
note() { printf '   %s\n' "$*" | tee -a "$LOG"; }
die()  { printf '   ABBRUCH %s\n' "$*" | tee -a "$LOG" >&2; exit 2; }
vm()   { colima ssh -- sudo sh -s; }          # Skript auf stdin, als root in der VM
vm_put()   { colima ssh -- sudo tee "$1" < "$2" >/dev/null; }   # vm_put <ziel-in-vm> <lokale-datei>
settle_db() { :; }   # in run_scenario: CHECKPOINT, damit WAL-Reste den Füllstand nicht verschieben
vm_now_ms() { colima ssh -- date -u +%s%3N | tr -d '\r'; }

# Compose-Argumente stehen je Projekt zeilenweise in einer Datei (Pfade dürfen Leerzeichen haben).
compose_in() { # compose_in <projekt> <args-datei> <compose-argumente …>
  local name="$1" file="$2" a=() l; shift 2
  while IFS= read -r l; do a+=("$l"); done < "$file"
  docker compose -p "$name" "${a[@]}" "$@"
}

# ── Aufräumen ───────────────────────────────────────────────────────────────
CREATED_IMAGES=()      # selbst gebaut oder selbst gezogen
PROJECTS=()            # Compose-Projekte (Name|Compose-Argumente-Datei)
CAPTURE_NAME=""
TMP_WT=""
cleanup() {
  local rc=$?
  set +e
  trap '' INT TERM HUP     # Aufräumen nicht unterbrechen lassen
  say "Aufräumen"
  for p in "${PROJECTS[@]:-}"; do
    [[ -z "$p" ]] && continue
    local name="${p%%|*}" args="${p#*|}"
    # shellcheck disable=SC2086
    compose_in "$name" "$args" down -v --remove-orphans >>"$LOG" 2>&1 && note "Projekt $name entfernt (samt Volumes)"
  done
  [[ -n "$CAPTURE_NAME" ]] && docker rm -f "$CAPTURE_NAME" >>"$LOG" 2>&1 && note "Container $CAPTURE_NAME entfernt"
  vm >>"$LOG" 2>&1 <<EOF
for m in \$(awk '\$2 ~ "^$VM_MNT_DIR/" {print \$2}' /proc/mounts | sort -r); do umount "\$m" || umount -l "\$m"; done
losetup -a | grep "$VM_IMG_DIR" | cut -d: -f1 | xargs -r -n1 losetup -d
rm -rf "$VM_IMG_DIR" "$VM_MNT_DIR"
rmdir /var/lib/kp-e2e /mnt/kp-e2e 2>/dev/null || true
EOF
  note "Loop-Dateisysteme unter $VM_MNT_DIR ausgehängt, $VM_IMG_DIR gelöscht"
  if [[ "$KEEP_IMAGE" == 1 ]]; then
    note "Image dvhub-kp-e2e:$RUN_ID bleibt (--keep-image)"
  fi
  for img in "${CREATED_IMAGES[@]:-}"; do
    [[ -z "$img" ]] && continue
    [[ "$KEEP_IMAGE" == 1 && "$img" == "dvhub-kp-e2e:$RUN_ID" ]] && continue
    docker rmi "$img" >>"$LOG" 2>&1 && note "Image $img entfernt"
  done
  if [[ -n "$TMP_WT" ]]; then
    git -C "$REPO" worktree remove --force "$TMP_WT" >>"$LOG" 2>&1 && note "temporärer Worktree entfernt"
  fi
  # Beleg: nichts mehr da
  {
    echo "--- Rest-Check"
    docker ps -a --format '{{.Names}}' | grep -E "^(kp-e2e|$RUN_ID)" || echo "keine Test-Container"
    docker volume ls --format '{{.Name}}' | grep -E "^kp-e2e-$RUN_ID" || echo "keine Test-Volumes"
    docker images --format '{{.Repository}}:{{.Tag}}' | grep -E "kp-e2e" || echo "keine Test-Images"
    colima ssh -- sh -c "grep -c kp-e2e /proc/mounts; ls /var/lib/kp-e2e 2>&1 | head -1"
  } >>"$OUT/cleanup.txt" 2>&1
  note "Rest-Check: $OUT/cleanup.txt"
  exit $rc
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ── Stand unter Test ────────────────────────────────────────────────────────
if [[ -n "$REF" ]]; then
  TMP_WT="$OUT/worktree"
  git -C "$REPO" worktree add --detach "$TMP_WT" "$REF" >>"$LOG" 2>&1 || die "Ref $REF nicht auffindbar"
  SRC="$TMP_WT"
else
  SRC="$(cd "${WORKTREE:-$REPO}" && pwd)"
fi
[[ -f "$SRC/docker/compose.yml" && -f "$SRC/Dockerfile" ]] || die "$SRC ist kein DVhub-Stand"
SHA="$(git -C "$SRC" rev-parse --short=8 HEAD 2>/dev/null || echo unbekannt)"
DIRTY="$( (git -C "$SRC" status --porcelain 2>/dev/null || true) | (grep -v '^??' || true) | wc -l | tr -d ' ')"
say "Kleine Platte E2E — Lauf $RUN_ID"
note "Stand: $SRC @ $SHA (geänderte Dateien: $DIRTY)"
note "Szenarien: $SCENARIOS · Daten: $DAYS Tage, Live-Abstand $STEP s · Wache: erst $KP_SHIM_FIRST_MS ms, dann alle $KP_SHIM_INTERVAL_MS ms"
note "Ergebnis: $OUT"
docker info >/dev/null 2>&1 || die "Docker unter $DOCKER_HOST nicht erreichbar"

# Was der Stand an Speicher-Schnittstellen mitbringt (nur zur Einordnung im Bericht).
{
  echo "sha=$SHA dirty=$DIRTY"
  echo "--- storage-Dateien"; (cd "$SRC/dvhub" && ls services | grep -iE 'storage|speicher' || true)
  echo "--- Routen /api/storage*"; grep -ohE "'/api/storage[^']*'" "$SRC/dvhub/routes-api.js" "$SRC"/dvhub/routes/*.js 2>/dev/null | sort -u || true
  echo "--- compose: dvhub-db im DVhub-Container?"; grep -nE 'dvhub-db:.*:ro|dvhub-db:/' "$SRC/docker/compose.yml" || true
  echo "--- compose: logging"; grep -n 'logging:' "$SRC/docker/compose.yml" || true
} > "$OUT/stand.txt"

# ── Images ──────────────────────────────────────────────────────────────────
ensure_image() { # ensure_image <ref> — zieht fehlende Basis-Images und merkt sie zum Löschen vor
  if ! docker image inspect "$1" >/dev/null 2>&1; then
    note "ziehe $1"
    docker pull -q "$1" >>"$LOG" 2>&1 || die "Image $1 nicht ladbar"
    CREATED_IMAGES+=("$1")
  fi
}
say "Images"
T0=$(date +%s)
docker build -q -t "dvhub-kp-e2e:$RUN_ID" --build-arg VCS_REF="$SHA" "$SRC" >>"$LOG" 2>&1 || die "Bau des DVhub-Images gescheitert (Log: $LOG)"
CREATED_IMAGES+=("dvhub-kp-e2e:$RUN_ID")
note "DVhub-Image dvhub-kp-e2e:$RUN_ID gebaut ($(( $(date +%s) - T0 )) s)"
ensure_image "timescale/timescaledb:$TS_TAG"
ensure_image "$CAPTURE_IMAGE"
[[ ",$SCENARIOS," == *",3,"* ]] && ensure_image "$PLAIN_PG_IMAGE"
if [[ ",$SCENARIOS," == *",2,"* ]]; then
  docker build -q -t "dvhub-kp-e2e-tsapache:$RUN_ID" --build-arg BASE="timescale/timescaledb:$TS_TAG" \
    -f "$KP/apache.Dockerfile" "$KP" >>"$LOG" 2>&1 || die "Apache-Image gescheitert"
  CREATED_IMAGES+=("dvhub-kp-e2e-tsapache:$RUN_ID")
  note "TimescaleDB-Apache-Image dvhub-kp-e2e-tsapache:$RUN_ID gebaut"
fi

# ── Gemeinsames: Shim-Ordner in der VM, Push-Mitschnitt ─────────────────────
vm >>"$LOG" 2>&1 <<EOF
set -e
mkdir -p "$VM_IMG_DIR" "$VM_SHIM_DIR"
chmod 755 "$VM_SHIM_DIR"
EOF
vm_put "$VM_SHIM_DIR/timer-shim.mjs" "$KP/timer-shim.mjs"
vm_put "$VM_SHIM_DIR/capture-server.mjs" "$KP/capture-server.mjs"
echo "chmod 644 '$VM_SHIM_DIR'/*" | vm
CAPTURE_NAME="kp-e2e-capture-$RUN_ID"
docker run -d --name "$CAPTURE_NAME" -e PORT="$CAPTURE_PORT" -v "$VM_SHIM_DIR:/kp:ro" "$CAPTURE_IMAGE" node /kp/capture-server.mjs >>"$LOG" 2>&1 \
  || die "Push-Mitschnitt startet nicht"
CAPTURE_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CAPTURE_NAME")"
note "Push-Mitschnitt (ntfy-Format) auf http://$CAPTURE_IP:$CAPTURE_PORT"

# ── Bausteine je Szenario ───────────────────────────────────────────────────
mkfs_disk() { # mkfs_disk <name> <GiB> → hängt ein ext4 der Größe ein, gibt den Mountpunkt aus
  vm >>"$LOG" 2>&1 <<EOF
set -e
truncate -s ${2}G "$VM_IMG_DIR/$1.img"
mkfs.ext4 -q -F -L "kp-$1" "$VM_IMG_DIR/$1.img"
mkdir -p "$VM_MNT_DIR/$1"
mount -o loop "$VM_IMG_DIR/$1.img" "$VM_MNT_DIR/$1"
mountpoint -q "$VM_MNT_DIR/$1"
EOF
  # macOS-bash 3.2: in $( … ) greift set -e nicht verlässlich — Fehler ausdrücklich weitergeben.
  [[ $? -eq 0 ]] || return 1
  echo "$VM_MNT_DIR/$1"
}
statfs_json() { # statfs_json <mount> → {"totalMb":…,"freeMb":…,"freePct":…} wie storage-guard (bavail)
  colima ssh -- stat -f -c '%b %a %S' "$1" | tr -d '\r' | awk '{t=$1*$3/1048576; f=$2*$3/1048576; printf("{\"totalMb\":%d,\"freeMb\":%d,\"freePct\":%.1f}", t, f, t>0?f*100/t:0)}'
}
fill_to() { # fill_to <mount> <ziel-frei-MB> → Füll-Dateien anlegen, bis bavail ≈ Ziel (± 3 %)
  local st free need n=0 total=0
  while (( n < 6 )); do
    st="$(colima ssh -- stat -f -c '%a %S' "$1" | tr -d '\r')"
    free=$(( $(awk '{print $1*$2}' <<<"$st") ))
    need=$(( free - $2 * 1048576 ))
    (( need <= $2 * 1048576 * 3 / 100 )) && break
    # Jede Runde eine NEUE Datei: fallocate auf eine vorhandene, größere Datei täte nichts.
    echo "fallocate -l $need '$1/kp-filler-$(date +%s)-$n-$RANDOM.bin'" | vm >>"$LOG" 2>&1 || die "Füllen von $1 gescheitert"
    total=$(( total + need )); n=$(( n + 1 ))
    settle_db; sleep 3
  done
  (( need < -($2 * 1048576 / 2) )) && note "Füllen $1: nur $(( free / 1048576 )) MB frei, Ziel $2 MB (DB schon größer)"
  note "Füller $1: $(( total / 1048576 )) MB in $n Datei(en) → $(statfs_json "$1")"
}
pct_to_mb() { # pct_to_mb <mount> <prozent>
  colima ssh -- stat -f -c '%b %S' "$1" | tr -d '\r' | awk -v p="$2" '{printf("%d", $1*$2/1048576*p/100)}'
}

run_scenario() {
  local id="$1"
  local name ts_mode disk_main disk_data="" gb_main gb_data=0 free_main_mb="" free_main_pct="" free_data_pct=""
  local expect_level expect_profile
  case "$id" in
    1) name="Docker Community, 12 GB, ~6 GB frei"; ts_mode=community; gb_main=12; free_main_mb=6144; expect_level="ok"; expect_profile="klein" ;;
    2) name="TimescaleDB Apache, 12 GB, ~8 % frei"; ts_mode=apache; gb_main=12; free_main_pct=8; expect_level="wenig|kritisch"; expect_profile="klein" ;;
    3) name="reines PostgreSQL, 12 GB, ~8 % frei"; ts_mode=plain; gb_main=12; free_main_pct=8; expect_level="wenig|kritisch"; expect_profile="klein" ;;
    4) name="winzige 4-GB-Platte, ~4 % frei (kritisch)"; ts_mode=community; gb_main=4; free_main_pct=4; expect_level="kritisch"; expect_profile="winzig" ;;
    5) name="PG auf eigener 6-GB-Platte (~4 % frei), DVhub-Daten 2 GB (~15 % frei)"; ts_mode=community; gb_main=6; free_main_pct=4; gb_data=2; free_data_pct=15; expect_level="kritisch"; expect_profile="winzig" ;;
    *) die "Szenario $id unbekannt" ;;
  esac
  local dir="$OUT/s$id"; mkdir -p "$dir"
  local project="kp-e2e-$RUN_ID-s$id"
  say "Szenario $id: $name"
  local t_start; t_start=$(date +%s)

  # Platten
  local m_main m_data
  m_main="$(mkfs_disk "s$id-main" "$gb_main")" || die "Platte s$id-main ($gb_main GB) nicht angelegt"
  if (( gb_data > 0 )); then m_data="$(mkfs_disk "s$id-data" "$gb_data")" || die "Platte s$id-data nicht angelegt"; else m_data="$m_main"; fi
  echo "mkdir -p '$m_main/db' '$m_data/data' '$m_data/config'" | vm >>"$LOG" 2>&1 || die "Verzeichnisse auf der Testplatte nicht angelegt"
  note "Platte PG-Daten: $m_main $(statfs_json "$m_main")"
  [[ "$m_data" != "$m_main" ]] && note "Platte DVhub-Daten: $m_data $(statfs_json "$m_data")"

  # Konfiguration (aus config.example.json des Stands): Port, Push an den Mitschnitt.
  "$NODE" -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    c.httpPort = Number(process.argv[2]);
    c.notifications = { enabled: true, providers: { ntfy: { enabled: true, topicUrl: process.argv[3] } } };
    fs.writeFileSync(process.argv[4], JSON.stringify(c, null, 2));
  ' "$SRC/dvhub/config.example.json" "$HTTP_PORT" "http://$CAPTURE_IP:$CAPTURE_PORT/kp-s$id" "$dir/config.json"
  vm_put "$m_data/config/config.json" "$dir/config.json"

  # Compose-Aufruf
  local envf="$dir/compose.env" argsf="$dir/compose.args"
  local ts_image="timescale/timescaledb" ts_tag="$TS_TAG" ts_flag=true
  case "$ts_mode" in
    apache) ts_image="dvhub-kp-e2e-tsapache"; ts_tag="$RUN_ID" ;;
    plain)  ts_image="${PLAIN_PG_IMAGE%%:*}"; ts_tag="${PLAIN_PG_IMAGE##*:}"; ts_flag=false ;;
  esac
  cat > "$envf" <<EOF
DB_ADMIN_PASSWORD=kp-admin-$RUN_ID
DVHUB_DB_PASSWORD=kp-app-$RUN_ID
DB_PORT=$DB_PORT
DVHUB_HTTP_PORT=$HTTP_PORT
DVHUB_IMAGE=dvhub-kp-e2e
DVHUB_TAG=$RUN_ID
TIMESCALE_IMAGE=$ts_image
TIMESCALE_TAG=$ts_tag
KP_DB_TIMESCALEDB=$ts_flag
KP_SHIM_DIR=$VM_SHIM_DIR
KP_SHIM_FIRST_MS=$KP_SHIM_FIRST_MS
KP_SHIM_INTERVAL_MS=$KP_SHIM_INTERVAL_MS
KP_DB_DIR=$m_main/db
KP_DATA_DIR=$m_data/data
KP_CONFIG_DIR=$m_data/config
EOF
  {
    printf '%s\n' -f "$SRC/docker/compose.yml" -f "$KP/compose.override.yml"
    if [[ "$ts_mode" == plain ]]; then printf '%s\n' -f "$KP/compose.plainpg.yml"; fi
    printf '%s\n' --env-file "$envf"
  } > "$argsf"
  PROJECTS+=("$project|$argsf")
  dc() { compose_in "$project" "$argsf" "$@"; }
  psql_db() { dc exec -T db psql -X -q -v ON_ERROR_STOP=1 "$@"; }
  status_get() { dc exec -T dvhub wget -qO- -T 10 "http://127.0.0.1:$HTTP_PORT$1" 2>/dev/null || true; }

  dc up -d --no-build --pull never >>"$LOG" 2>&1 || { dc logs --no-color >"$dir/compose-logs.txt" 2>&1; die "Stack startet nicht (s$id, $dir/compose-logs.txt)"; }
  note "Stack läuft ($(dc ps --format '{{.Service}}={{.Image}}' | tr '\n' ' '))"

  # Warten: Schema da, Tuning durch, Status-Route antwortet.
  local ok=0 i
  for i in $(seq 1 90); do
    if [[ "$(psql_db -U postgres -d dvhub -At -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('timeseries_samples','energy_slots_15m','audit_log')" 2>/dev/null | tr -d '\r')" == 3 ]] \
       && [[ -n "$(status_get /api/storage/status)" ]]; then ok=1; break; fi
    sleep 4
  done
  (( ok )) || { dc logs --no-color >"$dir/compose-logs.txt" 2>&1; die "DVhub/Schema nicht bereit (s$id, $dir/compose-logs.txt)"; }
  if [[ "$ts_mode" != plain ]]; then
    for i in $(seq 1 30); do
      [[ "$(psql_db -U postgres -d dvhub -At -c "SELECT extract(epoch FROM time_interval)::int FROM timescaledb_information.dimensions WHERE hypertable_name='timeseries_samples'" 2>/dev/null | tr -d '\r')" == 86400 ]] && break
      sleep 2
    done
  fi
  note "bereit nach $(( $(date +%s) - t_start )) s"

  # Daten: in KP_INSERT_WORKERS Sitzungen parallel (Tage verteilt), danach CHECKPOINT.
  local t_ins w workers="${KP_INSERT_WORKERS:-3}" fail=0; local pids=()
  t_ins=$(date +%s)
  for (( w = 0; w < workers; w++ )); do
    psql_db -U dvhub -d dvhub -v days="$DAYS" -v step="$STEP" -v worker="$w" -v workers="$workers" -f - < "$KP/synth-data.sql" >>"$LOG" 2>&1 &
    pids+=("$!")
  done
  for w in "${pids[@]}"; do wait "$w" || fail=1; done
  (( fail == 0 )) || die "Daten einspielen gescheitert (s$id)"
  psql_db -U postgres -d dvhub -c 'CHECKPOINT' >>"$LOG" 2>&1
  # DVhub neu starten — wie eine Bestandsbox nach dem Update: Daten liegen schon da,
  # Wache und Datenstufen beginnen frisch (Rückfüllung, Kompressions-Prüfung).
  dc restart dvhub >>"$LOG" 2>&1
  ok=0
  for i in $(seq 1 60); do [[ -n "$(status_get /api/storage/status)" ]] && { ok=1; break; }; sleep 2; done
  (( ok )) || die "DVhub nach Neustart nicht erreichbar (s$id)"
  snapshot() { psql_db -U postgres -d dvhub -v days="$DAYS" -f - < "$KP/snapshot.sql" 2>>"$LOG" | grep '^{' | tail -1; }
  settle_db() { psql_db -U postgres -d dvhub -c 'CHECKPOINT' >>"$LOG" 2>&1 || true; psql_db -U postgres -d dvhub -c 'CHECKPOINT' >>"$LOG" 2>&1 || true; }
  snapshot > "$dir/snap-before.json"
  note "Daten: $(( $(date +%s) - t_ins )) s · $("$NODE" -e 'const s=require(process.argv[1]);console.log(`${s.live_raw_rows} Live-Zeilen, ${s.live_series} Reihen, ältester ${s.live_raw_oldest_days} d, DB ${Math.round(s.db_bytes/1048576)} MB`)' "$dir/snap-before.json")"

  # Szenario 1: Kompression wirklich ausführen (Regel-Job von Hand anstoßen).
  if [[ "$id" == 1 ]]; then
    local job; job="$(psql_db -U postgres -d dvhub -At -c "SELECT job_id FROM timescaledb_information.jobs WHERE proc_name='policy_compression' AND hypertable_name='timeseries_samples'" | tr -d '\r' | head -1)"
    if [[ -n "$job" ]]; then
      local t_c; t_c=$(date +%s)
      psql_db -U postgres -d dvhub -c "CALL run_job($job)" >>"$LOG" 2>&1 || note "Kompressions-Job $job scheiterte"
      psql_db -U postgres -d dvhub -c 'CHECKPOINT' >>"$LOG" 2>&1
      snapshot > "$dir/snap-compressed.json"
      note "Kompressions-Job $job: $(( $(date +%s) - t_c )) s"
    else
      echo '{}' > "$dir/snap-compressed.json"; note "kein Kompressions-Job vorhanden"
    fi
  fi

  # Füllstand einstellen. fill_to setzt nach jeder Füll-Datei zwei CHECKPOINTs ab und misst neu,
  # bis der Stand hält (Postgres gibt nach Checkpoints WAL-Platz frei, auf 4 GB mehrere
  # Prozentpunkte). Danach wird NICHT mehr nachgefüllt: der Zeitstempel „at“ der Wache ist der
  # Beginn ihres Laufs — Nachfüllen während sie komprimiert, würde ihr Ergebnis verfälschen.
  statfs_json "$m_main" > "$dir/fs-main-before.json"
  local target
  if [[ -n "$free_main_mb" ]]; then target="$free_main_mb"; else target="$(pct_to_mb "$m_main" "$free_main_pct")"; fi
  fill_to "$m_main" "$target"
  if [[ "$m_data" != "$m_main" ]]; then fill_to "$m_data" "$(pct_to_mb "$m_data" "$free_data_pct")"; fi
  local fill_at; fill_at="$(vm_now_ms)"
  # Erst jetzt darf die Wache laufen (timer-shim: KP_SHIM_GATE). Läufe davor sind übersprungen,
  # damit kein Lauf mitten ins Füllen fällt und vor fill_at Platz schafft (Codex 30c76e1c).
  echo "touch '$m_data/data/kp-gate-open'" | vm >>"$LOG" 2>&1 || die "Freigabe für die Wache nicht gesetzt"
  statfs_json "$m_main" > "$dir/fs-main-filled.json"
  [[ "$m_data" != "$m_main" ]] && statfs_json "$m_data" > "$dir/fs-data-filled.json"

  # Wache beobachten: mindestens zwei Läufe nach dem Füllen; wird Löschen erwartet, bis eine
  # Löschung gemeldet ist (z. B. erst nach der Rückfüllung der Datenstufen) — höchstens
  # 5 Takte + 45 s.
  local deadline=$(( $(date +%s) + 5 * KP_SHIM_INTERVAL_MS / 1000 + 45 )) ticks=0 last_at="" dropped=0
  : > "$dir/status-polls.jsonl"; : > "$dir/warnings-polls.jsonl"
  while (( $(date +%s) < deadline )); do
    local s; s="$(status_get /api/storage/status)"
    [[ -n "$s" ]] && echo "$s" >> "$dir/status-polls.jsonl"
    local at_ms drop; read -r at_ms drop < <(printf '%s' "$s" | "$NODE" -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{try{const s=JSON.parse(b);const t=Date.parse(s.at||s.checkedAt||s.updatedAt||"");const d=(s.actions||[]).some(a=>/drop|prune|delete|retention/i.test(a.action||"")&&!a.error);console.log((Number.isFinite(t)?t:0)+" "+(d?1:0))}catch{console.log("0 0")}})')
    if (( at_ms > fill_at )) && [[ "$at_ms" != "$last_at" ]]; then
      ticks=$((ticks + 1)); last_at="$at_ms"; (( drop )) && dropped=1
      { printf '{"at":%s,"status":' "$at_ms"; printf '%s' "$s"; printf ',"api":'; status_get /api/status | "$NODE" -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{try{process.stdout.write(JSON.stringify({systemWarnings:JSON.parse(b).systemWarnings||null}))}catch{process.stdout.write("null")}})'; printf '}\n'; } >> "$dir/warnings-polls.jsonl"
      if (( ticks >= 2 )) && { [[ "$expect_level" == ok ]] || (( dropped )); }; then break; fi
    fi
    sleep 5
  done
  note "Wache: $ticks Lauf/Läufe nach dem Füllen gemeldet"
  echo "{\"fillAtMs\":$fill_at,\"ticksAfterFill\":$ticks,\"dropSeen\":$dropped}" > "$dir/guard-wait.json"

  # Einsammeln
  status_get /api/storage/status > "$dir/storage-status.json"
  status_get /api/status | "$NODE" -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{try{const s=JSON.parse(b);console.log(JSON.stringify({systemWarnings:s.systemWarnings||null}))}catch(e){console.log(JSON.stringify({error:String(e.message)}))}})' > "$dir/api-status.json"
  status_get /api/db/timescale/status > "$dir/timescale-status.json"
  psql_db -U postgres -d dvhub -At -c "SELECT coalesce(json_agg(json_build_object('ts', ts_utc, 'event', event_type, 'severity', severity, 'payload', payload) ORDER BY id), '[]') FROM public.audit_log WHERE event_type ~ '(storage|speicher|timescale|notification|db_tuning|migration|telemetry_init)'" \
    2>>"$LOG" | tr -d '\r' > "$dir/audit.json"
  docker logs "$CAPTURE_NAME" 2>&1 | grep "\"/kp-s$id\"" > "$dir/push.jsonl" || true
  dc logs --no-color dvhub > "$dir/dvhub-logs.txt" 2>&1 || true
  grep -E '\[kp-shim\]' "$dir/dvhub-logs.txt" > "$dir/shim.txt" || true
  docker inspect -f '{"running":{{.State.Running}},"restarts":{{.RestartCount}},"oomKilled":{{.State.OOMKilled}},"exitCode":{{.State.ExitCode}}}' "$(dc ps -q dvhub)" > "$dir/container-dvhub.json" 2>/dev/null || echo '{"running":false}' > "$dir/container-dvhub.json"
  docker inspect -f '{"running":{{.State.Running}},"restarts":{{.RestartCount}},"oomKilled":{{.State.OOMKilled}},"exitCode":{{.State.ExitCode}}}' "$(dc ps -q db)" > "$dir/container-db.json" 2>/dev/null || echo '{"running":false}' > "$dir/container-db.json"
  psql_db -U postgres -d dvhub -c 'CHECKPOINT' >>"$LOG" 2>&1 || true
  snapshot > "$dir/snap-after.json" || echo '{}' > "$dir/snap-after.json"
  statfs_json "$m_main" > "$dir/fs-main-after.json"
  [[ "$m_data" != "$m_main" ]] && statfs_json "$m_data" > "$dir/fs-data-after.json"

  cat > "$dir/meta.json" <<EOF
{"id":$id,"name":"$name","tsMode":"$ts_mode","diskMainGb":$gb_main,"diskDataGb":$gb_data,"separateData":$([[ "$m_data" != "$m_main" ]] && echo true || echo false),
 "expectLevel":"$expect_level","expectProfile":"$expect_profile","days":$DAYS,"stepS":$STEP,"sha":"$SHA","runId":"$RUN_ID",
 "shimFirstMs":$KP_SHIM_FIRST_MS,"shimIntervalMs":$KP_SHIM_INTERVAL_MS}
EOF

  # Abbauen (Volumes zeigen per Bind auf die Loop-Platte; down -v entfernt nur die Volume-Einträge).
  # Nur nach erfolgreichem Abbau austragen und die Platte aushängen — sonst bleibt beides
  # beim Aufräumen am Ende (Codex 30c76e1c).
  dc down -v --remove-orphans >>"$LOG" 2>&1 || die "Abbau von $project gescheitert — Aufräumen versucht es erneut"
  local keep=() p; for p in "${PROJECTS[@]}"; do if [[ "$p" != "$project|$argsf" ]]; then keep+=("$p"); fi; done; PROJECTS=("${keep[@]:-}")
  vm >>"$LOG" 2>&1 <<EOF
umount "$VM_MNT_DIR/s$id-main" 2>/dev/null; umount "$VM_MNT_DIR/s$id-data" 2>/dev/null
rm -f "$VM_IMG_DIR/s$id-main.img" "$VM_IMG_DIR/s$id-data.img"; rmdir "$VM_MNT_DIR/s$id-main" "$VM_MNT_DIR/s$id-data" 2>/dev/null; true
EOF
  "$NODE" "$KP/evaluate.mjs" "$dir" | tee -a "$LOG"
  note "Dauer Szenario $id: $(( $(date +%s) - t_start )) s"
}

T_ALL=$(date +%s)
IFS=',' read -r -a LIST <<<"$SCENARIOS"
for sid in "${LIST[@]}"; do run_scenario "$sid"; done

say "Zusammenfassung"
"$NODE" "$KP/evaluate.mjs" --summary "$OUT" "$(( $(date +%s) - T_ALL ))" "$RUN_ID" "$SCENARIOS" | tee -a "$LOG"
if "$NODE" -e 'process.exit(require(process.argv[1]).allGreen ? 0 : 1)' "$OUT/summary.json"; then exit 0; else exit 1; fi
