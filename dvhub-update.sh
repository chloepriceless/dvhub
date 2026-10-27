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
# git-Konfiguration (Gegenprüfung a75c2cea): vor jedem git-Schritt bereinigt
# (Block DVHUB GIT CONFIG); eine unzulässige Quelle (ext::, fd::, „-“ …) hält
# das Update mit Exit 5 an, ohne etwas umzuschreiben.
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

# BEGIN DVHUB GIT CONFIG — keep this block byte-identical in install.sh, post-update.sh and dvhub-update.sh.
# git-Konfiguration des Programmordners bereinigen (Gegenprüfung a75c2cea).
# Bis zur Rechte-Härtung vom 25.10.2026 gehörte .git dem Dienstbenutzer. Wer ihn
# kontrollierte, konnte in .git/config Befehle ablegen, die root bei git
# fetch/checkout ausführt: core.fsmonitor/sshCommand/pager, filter.*, diff.*,
# merge.*, remote.*.uploadpack, url.*.insteadOf (lenkt z. B. auf ssh mit eigenem
# core.sshCommand um), include.path, alias.*, credential.helper … — und in
# .git/info/attributes Dateien einem solchen Treiber zuordnen. Die -c-Schalter
# der root-Aufrufe decken nur Hooks und fsmonitor ab.
# Darum vor dem ersten git-Aufruf als root: in .git/config (und
# .git/config.worktree) bleiben nur die Schlüssel, die ein DVhub-Klon braucht
# (dvhub_git_key_allowed); alles andere wird entfernt — eine Zeile je Schlüssel
# im Log, ohne Wert —, das Original vorher gesichert (config.dvhub-bak-<zeit>,
# 0600). Ebenso Zeilen mit filter=, diff= oder merge= in .git/info/attributes.
# Kein neuer Klon (Download, Ausfall auf schwachen Boards, Forks und Spiegel).
# Die Quelle (remote.*.url) bleibt, wie sie ist — auch Forks und Spiegel. Hat
# sie eine unzulässige Form (ext::, fd::, unbekannter Transport, „-“ am Anfang),
# wird nichts umgeschrieben: Rückgabe 2, nichts geändert, das Update hält an.
# Ein unveränderter Klon bleibt Byte für Byte, wie er ist (keine Sicherung,
# keine Ausgabe). Liest die Datei mit git config --file --no-includes, nie über
# das Repo selbst.
# Rückgabe: 0 sauber oder bereinigt, 1 Fehler, 2 abgelehnt.
dvhub_git_key_allowed() {  # <schlüssel, wie git config --list ihn schreibt>
  case "$1" in
    core.repositoryformatversion|core.filemode|core.bare|core.logallrefupdates) return 0 ;;
    core.ignorecase|core.precomposeunicode|core.symlinks) return 0 ;;
    # Repository-Format: ohne seine Erweiterung ist ein Repo unlesbar; keine
    # nennt einen Befehl, unbekannte lehnt git selbst ab. config.worktree
    # (extensions.worktreeConfig) wird mit bereinigt.
    extensions.*) return 0 ;;
    remote.*.url|remote.*.fetch|remote.*.tagopt|remote.*.prune) return 0 ;;
    # Teil-Klon (--filter): ohne diese fehlen beim Auschecken Objekte.
    remote.*.promisor|remote.*.partialclonefilter) return 0 ;;
    branch.*.remote|branch.*.merge|branch.*.rebase) return 0 ;;
    gc.auto|fetch.prune|pull.rebase|pull.ff|user.name|user.email|advice.*) return 0 ;;
  esac
  return 1
}
dvhub_git_url_problem() {  # <url> — gibt den Grund aus (Rückgabe 0), wenn die Form unzulässig ist
  local u="$1" re scheme rest
  case "$u" in
    '') echo "leer"; return 0 ;;
    -*) echo "beginnt mit „-“ (würde als Option gelesen)"; return 0 ;;
    *[[:cntrl:]]*) echo "enthält Steuerzeichen"; return 0 ;;
  esac
  # <name>::… startet das Programm git-remote-<name> (ext:: führt Befehle aus).
  re='^([A-Za-z0-9+.-]+)::'
  if [[ "$u" =~ $re ]]; then echo "Fremdtransport ${BASH_REMATCH[1]}::"; return 0; fi
  re='^([A-Za-z][A-Za-z0-9+.-]*)://(.*)$'
  if [[ "$u" =~ $re ]]; then
    scheme="${BASH_REMATCH[1]}"; rest="${BASH_REMATCH[2]}"
    case "$(printf '%s' "$scheme" | tr '[:upper:]' '[:lower:]')" in
      https|http|ssh|git+ssh|ssh+git|git|file) ;;
      *) echo "unbekannter Transport ${scheme}://"; return 0 ;;
    esac
    re='^([^/@]*@)?-'
    if [[ "$rest" =~ $re ]]; then echo "Rechnername beginnt mit „-“"; return 0; fi
    return 1
  fi
  [[ "$u" == /* ]] && return 1   # lokaler Pfad
  # scp-Form [benutzer@]rechner:pfad (git@github.com:…)
  re='^([A-Za-z0-9._~%+-]+@)?([A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9A-Fa-f:.]+\]):'
  [[ "$u" =~ $re ]] && return 1
  echo "unbekannte Form (erlaubt: https://, ssh://, git@rechner:pfad, git://, file://, absoluter Pfad)"
  return 0
}
dvhub_git_mask() {  # <schlüssel> — Zugangsdaten in einer URL im Abschnittsnamen ausblenden
  local re='^(.*://)[^/@]*@(.*)$'
  if [[ "$1" =~ $re ]]; then printf '%s***@%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"; else printf '%s' "$1"; fi
}
dvhub_git_rm() { local x; for x in "$@"; do [[ -z "$x" ]] || rm -f "$x"; done; return 0; }
dvhub_git_backup_name() {  # <datei> <stempel>
  local bak="$1.dvhub-bak-$2" n=0
  while [[ -e "$bak" || -L "$bak" ]]; do n=$((n + 1)); bak="$1.dvhub-bak-$2-$n"; done
  printf '%s' "$bak"
}
dvhub_git_clean_file() {  # <datei> <schnappschuss> <schlüssel, zeilenweise> <stempel>
  local f="$1" snap="$2" keys="$3" tmp key sec left k bak
  tmp="$(mktemp "$f.dvhub-new.XXXXXX")" || return 1
  if ! cat "$snap" > "$tmp"; then rm -f "$tmp"; return 1; fi
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    if ! (cd / && git config --file "$tmp" --unset-all "$key"); then
      echo "  git-Konfiguration: $(dvhub_git_mask "$key") in $f nicht entfernbar — nichts geändert" >&2
      rm -f "$tmp"; return 1
    fi
  done <<< "$keys"
  if ! left="$(cd / && git config --file "$tmp" --no-includes --name-only --list)"; then rm -f "$tmp"; return 1; fi
  while IFS= read -r k; do
    [[ -z "$k" ]] || dvhub_git_key_allowed "$k" || { echo "  git-Konfiguration: $f nach dem Bereinigen nicht sauber — nichts geändert" >&2; rm -f "$tmp"; return 1; }
  done <<< "$left"
  # Abschnitte ohne verbliebenen Schlüssel ganz entfernen ([filter "x"] …).
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    sec="${key%.*}"
    case $'\n'"$left" in *$'\n'"$sec".*) continue ;; esac
    (cd / && git config --file "$tmp" --remove-section "$sec") 2>/dev/null || true
  done <<< "$keys"
  chmod 0644 "$tmp" || { rm -f "$tmp"; return 1; }
  bak="$(dvhub_git_backup_name "$f" "$4")"
  # Schnappschuss = Original, root-eigen 0600 (mktemp); dann atomar ersetzen.
  if ! mv -f "$snap" "$bak"; then rm -f "$tmp"; return 1; fi
  if ! mv -f "$tmp" "$f"; then rm -f "$tmp"; return 1; fi
  while IFS= read -r key; do
    [[ -n "$key" ]] && echo "  git-Konfiguration: $(dvhub_git_mask "$key") entfernt (.git/${f##*/.git/})"
  done <<< "$keys"
  echo "  git-Konfiguration: Original gesichert in $bak"
}
dvhub_sanitize_git_config() {  # <programmordner>
  local dir gd p f uid gid snap list origin entry key val why bad="" keys stamp re rc
  local snap_cfg="" keys_cfg="" snap_wt="" keys_wt=""
  dir="$(cd "$1" 2>/dev/null && pwd -P)" || return 0
  gd="$dir/.git"
  [[ -e "$gd" || -L "$gd" ]] || return 0
  # Verweise oder ein umgelenktes Repo (commondir) ließen root fremde Dateien
  # lesen oder schreiben — kommt in einem Klon nicht vor: ablehnen.
  for p in "$gd" "$gd/info"; do
    if [[ -L "$p" ]] || { [[ -e "$p" ]] && [[ ! -d "$p" ]]; }; then
      echo "  git-Konfiguration abgelehnt: $p ist kein Ordner (Verweis oder Datei) — nichts geändert, Update angehalten; bitte prüfen" >&2
      return 2
    fi
  done
  for p in "$gd/config" "$gd/config.worktree" "$gd/info/attributes" "$gd/commondir"; do
    if [[ -L "$p" ]] || { [[ -e "$p" ]] && [[ ! -f "$p" || "$p" == "$gd/commondir" ]]; }; then
      echo "  git-Konfiguration abgelehnt: $p ist ein Verweis oder lenkt git um — nichts geändert, Update angehalten; bitte prüfen" >&2
      return 2
    fi
  done
  [[ -f "$gd/config" ]] || return 0
  # Erst den Weg sichern (Ordner, .git, Dateien gehören dem Aufrufer, für andere
  # nicht schreibbar), sonst könnte der Dienstbenutzer Dateien zwischen Prüfen
  # und Schreiben austauschen. Auf einer root-eigenen Box ändert das nichts.
  uid="$(id -u)"; gid="$(id -g)"
  for p in "$dir" "$gd" "$gd/info" "$gd/config" "$gd/config.worktree" "$gd/info/attributes"; do
    [[ -e "$p" ]] || continue
    if [[ -n "$(find "$p" -maxdepth 0 \( ! -user "$uid" -o -perm -0020 -o -perm -0002 \) -print 2>/dev/null)" ]]; then
      if ! { chown -h "$uid:$gid" "$p" && chmod go-w "$p"; } 2>/dev/null; then
        echo "  git-Konfiguration: Besitz/Rechte von $p nicht zu setzen — nichts geändert" >&2
        return 1
      fi
    fi
  done
  # Lesen: Schnappschuss (danach ändert niemand mehr, was geprüft wurde).
  for f in config config.worktree; do
    [[ -f "$gd/$f" ]] || continue
    snap="$(mktemp "$gd/$f.dvhub-snap.XXXXXX")" || { dvhub_git_rm "$snap_cfg"; return 1; }
    list="$(mktemp "$gd/$f.dvhub-list.XXXXXX")" || { dvhub_git_rm "$snap" "$snap_cfg"; return 1; }
    rc=0
    cat "$gd/$f" > "$snap" || rc=1
    [[ "$rc" -eq 0 ]] && { (cd / && git config --file "$snap" --no-includes --show-origin --list -z) > "$list" || rc=1; }
    if [[ "$rc" -ne 0 ]]; then
      echo "  git-Konfiguration: $gd/$f nicht lesbar — nichts geändert" >&2
      dvhub_git_rm "$snap" "$list" "$snap_cfg"; return 1
    fi
    keys=""
    while IFS= read -r -d '' origin && IFS= read -r -d '' entry; do
      if [[ "$origin" != "file:$snap" ]]; then rc=1; break; fi
      key="${entry%%$'\n'*}"
      val=""
      [[ "$entry" == *$'\n'* ]] && val="${entry#*$'\n'}"
      if [[ "$key" == remote.*.url ]] && why="$(dvhub_git_url_problem "$val")"; then
        bad="$bad  git-Konfiguration abgelehnt: $(dvhub_git_mask "$key") in .git/$f — $why"$'\n'
      fi
      dvhub_git_key_allowed "$key" && continue
      case $'\n'"$keys" in *$'\n'"$key"$'\n'*) continue ;; esac
      keys="$keys$key"$'\n'
    done < "$list"
    rm -f "$list"
    if [[ "$rc" -ne 0 ]]; then
      echo "  git-Konfiguration: $gd/$f unerwartet gelesen — nichts geändert" >&2
      dvhub_git_rm "$snap" "$snap_cfg"; return 1
    fi
    if [[ "$f" == config ]]; then snap_cfg="$snap"; keys_cfg="$keys"; else snap_wt="$snap"; keys_wt="$keys"; fi
  done
  if [[ -n "$bad" ]]; then
    printf '%s' "$bad" >&2
    echo "  git-Konfiguration: Quelle nicht umgeschrieben, nichts geändert — Update angehalten; bitte remote-URL in $gd/config prüfen" >&2
    dvhub_git_rm "$snap_cfg" "$snap_wt"
    return 2
  fi
  stamp="$(date +%Y%m%d-%H%M%S)"
  rc=0
  if [[ -n "$keys_cfg" ]]; then dvhub_git_clean_file "$gd/config" "$snap_cfg" "$keys_cfg" "$stamp" || rc=1; fi
  if [[ -n "$keys_wt" && "$rc" -eq 0 ]]; then dvhub_git_clean_file "$gd/config.worktree" "$snap_wt" "$keys_wt" "$stamp" || rc=1; fi
  dvhub_git_rm "$snap_cfg" "$snap_wt"
  [[ "$rc" -eq 0 ]] || return 1
  # .git/info/attributes: Zeilen, die Dateien einem filter-, diff- oder
  # merge-Treiber zuordnen (Kommentare bleiben).
  f="$gd/info/attributes"
  re='^[[:space:]]*[^#[:space:]].*[[:space:]](filter|diff|merge)='
  if [[ -f "$f" ]] && grep -Eq "$re" "$f" 2>/dev/null; then
    snap="$(mktemp "$f.dvhub-snap.XXXXXX")" || return 1
    list="$(mktemp "$f.dvhub-new.XXXXXX")" || { rm -f "$snap"; return 1; }
    rc=0
    cat "$f" > "$snap" || rc=1
    if [[ "$rc" -eq 0 ]]; then grep -Ev "$re" "$snap" > "$list" || [[ $? -eq 1 ]] || rc=1; fi
    [[ "$rc" -eq 0 ]] && { chmod 0644 "$list" || rc=1; }
    if [[ "$rc" -eq 0 ]]; then
      p="$(dvhub_git_backup_name "$f" "$stamp")"
      mv -f "$snap" "$p" && mv -f "$list" "$f" || rc=1
    fi
    if [[ "$rc" -ne 0 ]]; then
      echo "  git-Attribute: $f nicht zu bereinigen" >&2
      rm -f "$snap" "$list"; return 1
    fi
    grep -E "$re" "$p" | while IFS= read -r entry; do
      echo "  git-Attribute: Zeile entfernt (.git/info/attributes): ${entry:0:120}"
    done
    echo "  git-Attribute: Original gesichert in $p"
  fi
  return 0
}
# END DVHUB GIT CONFIG

checkout_guarded() {  # <commit> <checkout-Argumente…>
  local sha="$1" pu; shift
  # Ganz einlesen statt `g show … | grep -q` (E2E 27.10.2026): unter pipefail
  # endet grep beim ersten Treffer, git stirbt beim Weiterschreiben an SIGPIPE,
  # und ein gültiger Stand galt als „älter als die Härtung“.
  pu="$(g show "${sha}:post-update.sh" 2>/dev/null)" || pu=""
  if [[ "$pu" != *"$FLOOR_MARK"* ]]; then
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

# git-Konfiguration vor jedem git-Aufruf bereinigen (Block oben). Abgelehnt
# (unzulässige Quelle) oder Fehler: Exit 5, git läuft nicht — und wie bei
# belegter Sperre bekommt die Hintergrund-Unit ihren Neustart-Merker zurück.
case "$action" in
  fetch|stash|stash-pop|checkout-tag|checkout-main|checkout-commit)
    if ! dvhub_sanitize_git_config "$INSTALL_DIR"; then
      [[ "${had_flag:-0}" -eq 1 ]] && touch "$NPM_RESTART_FLAG"
      die "git-Konfiguration in $INSTALL_DIR abgelehnt oder nicht zu bereinigen (Meldung oben) — Update angehalten; bitte $INSTALL_DIR/.git/config prüfen" 5
    fi
    ;;
esac

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
