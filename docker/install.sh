#!/bin/sh
# DVhub als Docker-Suite installieren (DVhub + TimescaleDB + EOS).
#
#   curl -fsSL https://raw.githubusercontent.com/chloepriceless/dvhub/main/docker/install.sh | bash
#
# Optionen (nach „bash -s --“):
#   --dir <pfad>     Installationsordner (Standard: ./dvhub)
#   --tag <tag>      DVhub-Image-Tag (Standard: latest; dev = Vorab-Stand)
#   --no-eos         ohne EOS-Optimierer (kleine Boxen)
#   --port <port>    Webport von DVhub (Standard: 8080)
#
# Idempotent: ein zweiter Lauf im selben Ordner behält .env (Passwörter!) und
# die Daten; er holt compose.yml neu und aktualisiert die Images.
set -eu

REPO_RAW="${DVHUB_REPO_RAW:-https://raw.githubusercontent.com/chloepriceless/dvhub/main}"
DIR="./dvhub"
TAG=""
NO_EOS=0
PORT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --no-eos) NO_EOS=1; shift ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;36m[dvhub]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[dvhub]\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker fehlt — https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Docker Compose (Plugin) fehlt — https://docs.docker.com/compose/install/linux/"
docker info >/dev/null 2>&1 || die "Docker läuft nicht oder keine Rechte (als root oder Mitglied der Gruppe docker ausführen)"
command -v curl >/dev/null 2>&1 || die "curl fehlt"

# Compose ≥ 2.23: die DB-Einrichtung steckt als „configs.content“ in compose.yml.
CV="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
CMAJ="$(echo "$CV" | cut -d. -f1)"; CMIN="$(echo "$CV" | cut -d. -f2)"
if [ "${CMAJ:-0}" -lt 2 ] || { [ "${CMAJ:-0}" -eq 2 ] && [ "${CMIN:-0}" -lt 23 ]; }; then
  die "Docker Compose $CV ist zu alt — mindestens 2.23 nötig (Docker aktualisieren)"
fi

mkdir -p "$DIR"
cd "$DIR"
say "Ordner: $(pwd)"

say "Lade compose.yml"
curl -fsSL -o compose.yml.new "$REPO_RAW/docker/compose.yml"
mv compose.yml.new compose.yml

rand() { (openssl rand -hex 24 2>/dev/null) || (head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'); }
setenv() { # setenv KEY VALUE — Zeile ersetzen oder anhängen
  if grep -q "^$1=" .env; then
    sed "s|^$1=.*|$1=$2|" .env > .env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

if [ -f .env ]; then
  say ".env vorhanden — Passwörter und Einstellungen bleiben"
else
  say "Lege .env an (zufällige Passwörter)"
  curl -fsSL -o .env "$REPO_RAW/docker/.env.example"
  setenv DB_ADMIN_PASSWORD "$(rand)"
  setenv DVHUB_DB_PASSWORD "$(rand)"
  chmod 600 .env
fi
[ -n "$TAG" ] && setenv DVHUB_TAG "$TAG"
[ -n "$PORT" ] && setenv DVHUB_HTTP_PORT "$PORT"
[ "$NO_EOS" = 1 ] && setenv COMPOSE_PROFILES ""

say "Lade Images (DVhub, TimescaleDB$( [ "$NO_EOS" = 1 ] || echo ', EOS'))"
docker compose pull
say "Starte"
docker compose up -d

HTTP_PORT="$(grep '^DVHUB_HTTP_PORT=' .env | cut -d= -f2)"
say "Warte auf DVhub …"
i=0
while [ $i -lt 60 ]; do
  cid="$(docker compose ps -q dvhub 2>/dev/null || true)"
  st="$( [ -n "$cid" ] && docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)"
  [ "$st" = healthy ] && break
  i=$((i + 1)); sleep 3
done
[ "${st:-}" = healthy ] || die "DVhub ist nicht gesund geworden — Logs: docker compose -f $(pwd)/compose.yml logs dvhub"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "Fertig. DVhub läuft: http://${IP:-<host>}:${HTTP_PORT:-8080}"
say "Aktualisieren:  cd $(pwd) && docker compose pull && docker compose up -d"
say "API-Token:      docker compose -f $(pwd)/compose.yml exec dvhub node -p 'require(\"/etc/dvhub/config.json\").apiToken'"
