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
# Untergrenze: ausgecheckt wird nur ein Stand, dessen post-update.sh die Marke
# DVHUB_ROOT_OWNED_INSTALL trägt. Ältere Stände gäben /opt/dvhub wieder dem
# Dienstbenutzer (chown -R) und brächten die alten sudoers-Regeln zurück —
# über die Oberfläche also nicht installierbar, nur von Hand als root.
set -euo pipefail
# Feste Sprache: routes/admin-routes.js erkennt "No local changes" am Text.
export LC_ALL=C

INSTALL_DIR="@INSTALL_DIR@"
EFFECTIVE_UID="$EUID"
if [[ "$INSTALL_DIR" == "@INSTALL_DIR@" ]]; then
  # Nicht installierte Kopie: nur für Tests (test/dvhub-update-helper.test.js).
  INSTALL_DIR="${DVHUB_UPDATE_TEST_INSTALL_DIR:-}"
  EFFECTIVE_UID="${DVHUB_UPDATE_TEST_EUID:-$EUID}"
fi
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
    (cd "$APP_DIR" && env HOME="${DVHUB_UPDATE_TEST_HOME:-/root}" npm install --omit=dev)
    sha256sum "$lock" | awk '{print $1}' > "$NPM_MARKER"
    ;;
  post-update)
    exec bash "$INSTALL_DIR/post-update.sh"
    ;;
esac
