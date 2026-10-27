#!/usr/bin/env bash
# dvhub-update.sh — root-eigener Einstieg für das Software-Update aus der
# Oberfläche (/api/admin/update/check|apply|channel, routes/admin-routes.js).
#
# Warum (Review 25.10.2026, P1): der Programmordner /opt/dvhub gehörte dem
# Dienstbenutzer, root führte aber bei jedem Dienststart post-update.sh und
# weitere Dateien daraus aus. Jetzt gehört /opt/dvhub root; der Dienstbenutzer
# kann dort nichts mehr schreiben. Was das Update dort ändern muss (git, npm,
# post-update.sh), erledigt dieses Skript als root — mit festen Befehlen und
# geprüften Argumenten statt sudo auf einen beschreibbaren Pfad.
#
# install.sh/post-update.sh kopieren es nach /usr/local/libexec/dvhub-update
# (root:root 0755) und tragen dabei den Programmordner fest ein (@INSTALL_DIR@).
# Die sudoers-Regeln zeigen nur auf diese Kopie.
#
# Nutzung (als root, über sudo -n):
#   dvhub-update fetch                  # git fetch --tags origin
#   dvhub-update stash                  # nur geänderte versionierte Dateien
#   dvhub-update stash-pop
#   dvhub-update checkout-tag <vX.Y.Z>  # Release-Tag
#   dvhub-update checkout-main          # git checkout -B main origin/main
#   dvhub-update checkout-commit <sha>  # Commit (Pin, Rückroll)
#   dvhub-update npm-install            # npm install --omit=dev (+ Marker)
#   dvhub-update post-update            # post-update.sh
#
# Sperre (Gegenprüfung 25.10.2026): alle ändernden Schritte nehmen dieselbe
# Sperre wie die Hintergrund-Unit dvhub-npm-install aus post-update.sh
# (/run/lock/dvhub-update.lock). Ist sie belegt, Exit 4 („läuft bereits“) statt
# zwei npm-Läufen auf einem node_modules oder einem Checkout unter laufendem npm.
# npm-install hat eine eigene Zeitgrenze unter der der Oberfläche (10 min), und
# TERM an dieses Skript (Timeout der Oberfläche beendet sudo, sudo reicht TERM
# weiter) beendet npm mit — früher lief es weiter und stieß mit dem Rückweg
# zusammen.
#
# Untergrenze: ausgecheckt wird nur ein Stand, dessen post-update.sh die Marke
# DVHUB_ROOT_OWNED_INSTALL trägt. Ältere Stände gäben /opt/dvhub wieder dem
# Dienstbenutzer (chown -R) und brächten die alten sudoers-Regeln zurück —
# über die Oberfläche also nicht installierbar, nur von Hand als root.
set -euo pipefail
# Feste Sprache: routes/admin-routes.js erkennt "No local changes" am Text.
export LC_ALL=C

INSTALL_DIR="@INSTALL_DIR@"
# Dienstname für post-update.sh (sudo leert die Umgebung; Gegenprüfung a2ff2a85).
SERVICE_NAME="@SERVICE_NAME@"
[[ "$SERVICE_NAME" == "@SERVICE_NAME@" ]] && SERVICE_NAME=dvhub
EFFECTIVE_UID="$EUID"
LOCK_FILE=/run/lock/dvhub-update.lock
# Merker der Hintergrund-Unit dvhub-npm-install (post-update.sh): „nach npm
# DVhub neu starten“. Ein Update aus der Oberfläche startet selbst neu.
NPM_RESTART_FLAG=/run/dvhub-npm-restart
if [[ "$INSTALL_DIR" == "@INSTALL_DIR@" ]]; then
  # Nicht installierte Kopie: nur für Tests (test/dvhub-update-helper.test.js).
  INSTALL_DIR="${DVHUB_UPDATE_TEST_INSTALL_DIR:-}"
  EFFECTIVE_UID="${DVHUB_UPDATE_TEST_EUID:-$EUID}"
  LOCK_FILE="${DVHUB_UPDATE_TEST_LOCK:-$INSTALL_DIR/.update.lock}"
  NPM_RESTART_FLAG="${DVHUB_UPDATE_TEST_RESTART_FLAG:-$INSTALL_DIR/.npm-restart}"
fi
NPM_TIMEOUT_S=420
APP_DIR="$INSTALL_DIR/dvhub"
NPM_MARKER="$INSTALL_DIR/.npm-install-hash"
FLOOR_MARK="DVHUB_ROOT_OWNED_INSTALL"
TAG_RE='^v?[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9._-]+)?$'
SHA_RE='^[0-9a-fA-F]{7,40}$'

die() { echo "dvhub-update: $1" >&2; exit "${2:-1}"; }
usage() { die "Aufruf: dvhub-update fetch|stash|stash-pop|checkout-tag <tag>|checkout-main|checkout-commit <sha>|npm-install|post-update" 2; }

[[ "$EFFECTIVE_UID" -eq 0 ]] || die "muss als root laufen"
[[ -n "$INSTALL_DIR" && -d "$INSTALL_DIR/.git" ]] || die "kein Programmordner (${INSTALL_DIR:-?})"

# git als root im Programmordner: keine Hooks, kein fsmonitor; Identität nur
# für git stash (legt intern Commits an).
g() {
  git -c safe.directory="$INSTALL_DIR" -c core.hooksPath=/dev/null -c core.fsmonitor=false \
    -c advice.detachedHead=false -c user.name=DVhub -c user.email=dvhub@localhost \
    -C "$INSTALL_DIR" "$@"
}

checkout_guarded() {  # <commit> <checkout-Argumente…>
  local sha="$1"; shift
  if ! g show "${sha}:post-update.sh" 2>/dev/null | grep -q "$FLOOR_MARK"; then
    die "Zielstand ${sha:0:7} ist älter als die Rechte-Härtung vom 25.10.2026 — über die Oberfläche nicht installierbar (von Hand als root: git checkout + post-update.sh)" 3
  fi
  g checkout "$@"
}

action="${1:-}"
case "$action" in
  fetch|stash|stash-pop|checkout-main|npm-install|post-update) [[ $# -eq 1 ]] || usage ;;
  checkout-tag|checkout-commit) [[ $# -eq 2 ]] || usage ;;
  *) usage ;;
esac

# Sperre für alle ändernden Schritte (nicht post-update: das startet
# Hintergrund-Units, die den Deskriptor sonst erben würden).
# Neustart-Merker der Hintergrund-Unit (Gegenprüfung 6e7f6bfb): ein Schritt
# eines echten Updates nimmt ihn weg — die Unit soll DVhub nicht mitten im
# Update neu starten, das Update startet am Ende selbst neu. fetch (auch die
# bloße Update-Prüfung) lässt ihn stehen. Kommt der Schritt nicht an die
# Sperre (Exit 4), läuft kein Update: dann bekommt die Unit ihn zurück.
if [[ "$action" != post-update ]]; then
  had_flag=0
  if [[ "$action" != fetch && -e "$NPM_RESTART_FLAG" ]]; then
    had_flag=1
    rm -f "$NPM_RESTART_FLAG"
  fi
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE" || die "Sperre $LOCK_FILE nicht anlegbar"
    if [[ "$action" == npm-install ]]; then lock_wait=120; else lock_wait=20; fi
    if ! flock -w "$lock_wait" 9; then
      [[ "$had_flag" -eq 1 ]] && touch "$NPM_RESTART_FLAG"
      die "ein anderer Update- oder npm-Lauf läuft bereits (z. B. npm im Hintergrund nach einem Neustart) — bitte in ein paar Minuten erneut versuchen" 4
    fi
  fi
fi

# <befehl…> im Hintergrund; TERM/INT/HUP an dieses Skript beenden ihn mit.
# Mit `timeout` (eigene Prozessgruppe) trifft das auch die Kindprozesse von npm.
run_killable() {
  local pid rc=0
  "$@" &
  pid=$!
  trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; exit 143' TERM INT HUP
  wait "$pid" || rc=$?
  trap - TERM INT HUP
  return "$rc"
}

case "$action" in
  fetch)
    g fetch --tags --quiet origin
    ;;
  stash)
    # Nur versionierte Dateien (Review 25.10.2026): untracked Laufzeitordner
    # (eos-venv/, forecast-venv/, bin/) bleiben, wo sie sind.
    g stash push
    ;;
  stash-pop)
    g stash pop
    ;;
  checkout-tag)
    tag="$2"
    [[ "$tag" =~ $TAG_RE ]] || die "ungültiger Tag" 2
    sha="$(g rev-parse --verify --quiet "refs/tags/${tag}^{commit}")" || die "Tag $tag nicht vorhanden" 2
    checkout_guarded "$sha" "refs/tags/$tag"
    ;;
  checkout-main)
    sha="$(g rev-parse --verify --quiet "refs/remotes/origin/main^{commit}")" || die "origin/main nicht vorhanden" 2
    checkout_guarded "$sha" -B main origin/main
    ;;
  checkout-commit)
    ref="$2"
    [[ "$ref" =~ $SHA_RE ]] || die "ungültiger Commit" 2
    sha="$(g rev-parse --verify --quiet "${ref}^{commit}")" || die "Commit $ref nicht vorhanden" 2
    checkout_guarded "$sha" --detach "$sha"
    ;;
  npm-install)
    [[ -f "$APP_DIR/package.json" ]] || die "kein package.json in $APP_DIR"
    lock="$APP_DIR/package-lock.json"
    [[ -f "$lock" ]] || lock="$APP_DIR/package.json"
    # Marker vor dem Lauf ungültig, erst nach Erfolg neu (wie post-update.sh):
    # ein abgebrochener Lauf wird beim nächsten Start repariert.
    rm -f "$NPM_MARKER"
    cd "$APP_DIR"
    if command -v timeout >/dev/null 2>&1; then
      run_killable timeout -k 15 "$NPM_TIMEOUT_S" env HOME="${DVHUB_UPDATE_TEST_HOME:-/root}" npm install --omit=dev
    else
      run_killable env HOME="${DVHUB_UPDATE_TEST_HOME:-/root}" npm install --omit=dev
    fi
    sha256sum "$lock" | awk '{print $1}' > "$NPM_MARKER"
    ;;
  post-update)
    # Programmordner und Dienstname mitgeben: unter sudo fehlen sie sonst.
    exec env INSTALL_DIR="$INSTALL_DIR" SERVICE_NAME="$SERVICE_NAME" bash "$INSTALL_DIR/post-update.sh"
    ;;
esac
