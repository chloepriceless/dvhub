#!/usr/bin/env bash
# dev-worker.sh — lokaler Worker für dev-Pakete (Bleeding Edge) auf dem Mac.
#
# Christin 24.11.2026: „selber auf dem Mac bauen mit einem eigenen Worker —
# ähnlich automatisch wie auf GitHub“. launchd ruft das Skript alle 10 Minuten
# auf (zone.bikini.dvhub-dev-worker). Je Lauf:
#
#   fetch origin/main (eigener Klon, nie der Arbeits-Checkout ~/Projects/DVhub)
#   → Übergang erledigt? (dev-Schlüssel in release-keys/allowed_signers von main,
#     channels/index-dev-v2.json vorhanden — sonst nichts, siehe docs/release-pakete.md)
#   → schon veröffentlicht? (Zustandsdatei + Assets am Release dev/dev-bridge +
#     signierter Eintrag in index-dev-v2.json)
#   → CI grün? (scripts/ci-check.py) → Signier-Probe mit dem dev-Schlüssel
#   → build-release.sh --sig-scope dev → publish-release.sh --sig-scope dev
#   → Zustand schreiben, Mitteilung.
#
# Signiert wird NUR mit dem dev-Schlüssel (~/.config/dvhub-release/dev_ed25519,
# eine Datei, kein Agent, kein 1Password): Namensräume dvhub-release-dev und
# dvhub-release-index-dev, die Boxen nur für dev annehmen. Nur main von
# chloepriceless/dvhub, nur Kanal dev — nie stable, nie Tags, nie die
# eingefrorene index-dev.json.
#
#   dev-worker.sh                    ein Lauf (so ruft launchd es auf)
#   dev-worker.sh --dry-run [--sha REF]
#                                    echter Bau samt Signatur, publish-release nur
#                                    --dry-run; kein Zustand, keine Veröffentlichung.
#                                    REF muss auf origin/main liegen (Standard: origin/main).
#   dev-worker.sh --probe-sign       nur prüfen, ob der dev-Schlüssel signiert
#   dev-worker.sh --install          sich nach $DW_HOME/bin kopieren, Plist schreiben, laden
#   dev-worker.sh --print-plist      Plist auf stdout
#
# Stoppen: launchctl bootout gui/$(id -u)/zone.bikini.dvhub-dev-worker
#
# Rückgabe: 0 = Lauf ordentlich beendet (auch „nichts zu tun“, „CI läuft“,
# „läuft schon“, „Übergang fehlt“), 1 = Fehler (Bau, Veröffentlichung, Schlüssel …), 2 = Aufruf.
set -uo pipefail
# Kein Agent: der dev-Schlüssel ist eine Datei; so kann auch kein Werkzeug
# darunter versehentlich 1Password fragen.
unset SSH_AUTH_SOCK

LABEL="zone.bikini.dvhub-dev-worker"
GH_REPO="chloepriceless/dvhub"
CANON_ORIGIN="https://github.com/$GH_REPO.git"

DW_HOME="${DVHUB_DW_HOME:-$HOME/Library/Application Support/dvhub-dev-worker}"
DW_LOG="${DVHUB_DW_LOG:-$HOME/Library/Logs/dvhub-dev-worker.log}"
DW_ORIGIN="${DVHUB_DW_ORIGIN:-$CANON_ORIGIN}"
DW_API="${DVHUB_DW_API:-https://api.github.com}"
DW_DOWNLOAD="${DVHUB_DW_DOWNLOAD:-https://github.com}"
DW_KEY="${DVHUB_DW_KEY:-$HOME/.config/dvhub-release/dev_ed25519}"
DW_ARCHS="${DVHUB_DW_ARCHS:-arm64,armhf,amd64}"
DW_AGENT_TIMEOUT="${DVHUB_DW_AGENT_TIMEOUT:-60}"       # s: Signier-Probe
DW_BUILD_TIMEOUT="${DVHUB_DW_BUILD_TIMEOUT:-5400}"     # s: build-release (3 Architekturen)
DW_PUBLISH_TIMEOUT="${DVHUB_DW_PUBLISH_TIMEOUT:-2700}" # s: publish-release
DW_NET_TIMEOUT="${DVHUB_DW_NET_TIMEOUT:-600}"          # s: clone/fetch
DW_LOCK_MAX_AGE="${DVHUB_DW_LOCK_MAX_AGE:-14400}"      # s: älter = Vorlauf hängt
DW_KEEP_BUILDS="${DVHUB_DW_KEEP_BUILDS:-2}"
DW_MAX_FAILS="${DVHUB_DW_MAX_FAILS:-3}"                # Bau-/Veröffentlichungs-Versuche je Commit
DW_LOG_MAX_BYTES="${DVHUB_DW_LOG_MAX_BYTES:-524288}"
DW_PYTHON="${DVHUB_DW_PYTHON:-python3}"
# Werkzeuge (build-/publish-release.sh): Vorgabe der Worker-Klon auf dem Stand
# von origin/main — auch für Trockenläufe älterer Commits (Codex f9e2e163).
# DVHUB_DW_TOOLS: anderes Checkout mit scripts/release (z. B. vor dem Merge).
DW_TOOLS="${DVHUB_DW_TOOLS:-}"

REPO="$DW_HOME/repo"
STATE="$DW_HOME/state"
OUT="$DW_HOME/out"
RUNS="$DW_HOME/runs"
LOCK="$DW_HOME/lock"
KEY="$DW_KEY"

MODE=run
DRY_REF=""

usage() { sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) MODE=dry; shift ;;
    --sha) [[ $# -ge 2 && -n "$2" ]] || { echo "dev-worker: --sha braucht einen Wert" >&2; exit 2; }
           DRY_REF="$2"; shift 2 ;;
    --probe-sign) MODE=probe; shift ;;
    --install) MODE=install; shift ;;
    --print-plist) MODE=plist; shift ;;
    -h|--help) usage ;;
    *) echo "dev-worker: unbekanntes Argument $1" >&2; usage ;;
  esac
done
[[ -z "$DRY_REF" || "$MODE" == dry ]] || { echo "dev-worker: --sha nur mit --dry-run" >&2; exit 2; }

# ---------------------------------------------------------------- Hilfen
now() { date '+%Y-%m-%d %H:%M:%S'; }
rotate_log() {
  local size
  [[ -f "$DW_LOG" ]] || return 0
  size="$(wc -c < "$DW_LOG" | tr -d ' ')"
  [[ "$size" -gt "$DW_LOG_MAX_BYTES" ]] || return 0
  rm -f "$DW_LOG.3"
  [[ -f "$DW_LOG.2" ]] && mv -f "$DW_LOG.2" "$DW_LOG.3"
  [[ -f "$DW_LOG.1" ]] && mv -f "$DW_LOG.1" "$DW_LOG.2"
  mv -f "$DW_LOG" "$DW_LOG.1"
}
log() {
  local line
  line="$(now) [$$]$([[ "$MODE" == dry ]] && echo ' [dry-run]') $*"
  printf '%s\n' "$line" >> "$DW_LOG"
  [[ -t 2 ]] && printf '%s\n' "$line" >&2
  return 0
}
notify() {  # $1 = Text; macOS-Mitteilung, nie fatal
  command -v osascript >/dev/null 2>&1 || return 0
  osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title (item 2 of argv)' -e 'end run' \
    "$1" "DVhub dev-Paket" >/dev/null 2>&1 || true
}
# Befehl mit Zeitlimit; Rückgabe 124 bei Ablauf (wie timeout(1)). Der Befehl
# läuft in eigener Prozessgruppe; bei Ablauf — oder wenn der Worker selbst ein
# TERM/INT/HUP bekommt (launchctl bootout) — wird die GANZE Gruppe beendet
# (TERM, nach 10 s KILL), damit kein ssh-keygen/docker/gh weiterläuft, während
# schon der nächste Lauf die Sperre hat (Codex 1ab4b3f4). perl gibt es auf
# macOS und Linux; timeout(1) beendet je nach Variante nur das Kind.
run_to() {
  perl -e '
    use strict; use POSIX ();
    my $secs = shift @ARGV;
    my $pid = fork; defined $pid or exit 126;
    if ($pid == 0) { setpgrp(0, 0); exec { $ARGV[0] } @ARGV; exit 127; }
    my $timedout = 0; my $stage = 0;
    my $grp = sub { kill $_[0], -$pid; };
    $SIG{ALRM} = sub { $timedout = 1; if ($stage++ == 0) { $grp->("TERM"); alarm 10; } else { $grp->("KILL"); } };
    for my $sig (qw(TERM INT HUP)) { $SIG{$sig} = sub { $grp->("TERM"); sleep 2; $grp->("KILL"); POSIX::_exit(143); }; }
    alarm $secs;
    my $st;
    while (1) { my $r = waitpid($pid, 0); if ($r == $pid) { $st = $?; last; } last if $r == -1 && !$!{EINTR}; }
    alarm 0;
    $grp->("KILL");   # übrig gebliebene Enkel der Gruppe
    exit 124 if $timedout;
    exit 1 unless defined $st;
    exit(($st & 127) ? 128 + ($st & 127) : $st >> 8);
  ' "$@"
}
state_get() { cat "$STATE/$1" 2>/dev/null || true; }
state_set() { [[ "$MODE" == dry ]] && return 0; printf '%s\n' "$2" > "$STATE/$1.tmp" && mv -f "$STATE/$1.tmp" "$STATE/$1"; }
state_clear() { [[ "$MODE" == dry ]] && return 0; rm -f "$STATE/$1"; }
# Einmal-Meldung: meldet nur, wenn sich der Schlüssel (z. B. SHA) geändert hat.
notify_once() {  # $1 = Zustandsname, $2 = Schlüssel, $3 = Text
  if [[ "$(state_get "$1")" != "$2" ]]; then
    notify "$3"
    state_set "$1" "$2"
  fi
}
gh_token() {
  # Nur für die Tests (test/release-dev-worker.test.js): nie den echten Schlüsselbund befragen.
  if [[ -n "${DVHUB_DW_FAKE_TOKEN:-}" ]]; then printf '%s\n' "$DVHUB_DW_FAKE_TOKEN"; return 0; fi
  printf 'protocol=https\nhost=github.com\n\n' \
    | GIT_TERMINAL_PROMPT=0 run_to 20 git credential fill 2>/dev/null | sed -n 's/^password=//p'
}
# GitHub-API lesen; Token (falls vorhanden) nur über stdin an curl, nie in argv.
api_get() {  # $1 = Pfad, $2 = Zieldatei
  local tok; tok="$(gh_token)"
  if [[ -n "$tok" ]]; then
    printf 'header = "Authorization: Bearer %s"\n' "$tok" \
      | curl -fsS --max-time 60 -K - -H 'Accept: application/vnd.github+json' -H 'User-Agent: dvhub-dev-worker' \
          -o "$2" "$DW_API$1"
  else
    curl -fsS --max-time 60 -H 'Accept: application/vnd.github+json' -H 'User-Agent: dvhub-dev-worker' -o "$2" "$DW_API$1"
  fi
}

# ---------------------------------------------------------------- Plist / Installation
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
# Beim Installieren gesetzte Einstellungen wandern in die Plist, damit der
# geplante Lauf dieselben Ordner/Schlüssel nutzt (Codex 1ab4b3f4).
plist_env() {
  local v
  for v in DVHUB_DW_HOME DVHUB_DW_LOG DVHUB_DW_KEY DVHUB_DW_ARCHS DVHUB_DW_AGENT_TIMEOUT \
           DVHUB_DW_BUILD_TIMEOUT DVHUB_DW_PUBLISH_TIMEOUT DVHUB_DW_KEEP_BUILDS DVHUB_DW_MAX_FAILS; do
    [[ -n "${!v:-}" ]] || continue
    printf '\t\t<key>%s</key>\n\t\t<string>%s</string>\n' "$v" "$(xml_escape "${!v}")"
  done
}
print_plist() {
  local self="$DW_HOME/bin/dev-worker.sh"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$(xml_escape "$self")</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>DOCKER_HOST</key>
		<string>unix://$HOME/.colima/default/docker.sock</string>
		<key>LANG</key>
		<string>de_DE.UTF-8</string>
$(plist_env)
	</dict>
	<key>StartInterval</key>
	<integer>600</integer>
	<key>RunAtLoad</key>
	<false/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$HOME/Library/Logs/dvhub-dev-worker.launchd.log</string>
	<key>StandardErrorPath</key>
	<string>$HOME/Library/Logs/dvhub-dev-worker.launchd.log</string>
	<key>WorkingDirectory</key>
	<string>$HOME</string>
</dict>
</plist>
EOF
}
if [[ "$MODE" == plist ]]; then print_plist; exit 0; fi
if [[ "$MODE" == install ]]; then
  plist="${DVHUB_DW_LAUNCHAGENTS:-$HOME/Library/LaunchAgents}/$LABEL.plist"
  idie() { echo "dev-worker --install: $*" >&2; exit 1; }
  mkdir -p "$DW_HOME/bin" "$(dirname "$plist")" "$(dirname "$DW_LOG")" || idie "Ordner nicht anlegbar"
  # Kopie statt Verweis ins Repo: ein Checkout darf das laufende Skript nicht überschreiben.
  install -m 0755 "$0" "$DW_HOME/bin/dev-worker.sh.new" && mv -f "$DW_HOME/bin/dev-worker.sh.new" "$DW_HOME/bin/dev-worker.sh" \
    || idie "Skript nicht kopierbar"
  print_plist > "$plist.new" || idie "Plist nicht schreibbar"
  if command -v plutil >/dev/null 2>&1; then plutil -lint "$plist.new" >/dev/null || idie "Plist ungültig"; fi
  mv -f "$plist.new" "$plist" || idie "Plist nicht schreibbar"
  if [[ -z "${DVHUB_DW_NO_LAUNCHCTL:-}" ]]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist" || idie "launchctl bootstrap fehlgeschlagen — Worker ist NICHT geladen"
  fi
  echo "installiert: $DW_HOME/bin/dev-worker.sh, $plist"
  exit 0
fi

mkdir -p "$DW_HOME" "$STATE" "$OUT" "$RUNS" "$(dirname "$DW_LOG")" || exit 1
chmod 700 "$DW_HOME" 2>/dev/null || true
# Kopie des Release-.pub aus der 1Password-Zeit (bis 24.11.2026) — nur genau
# diese Dateien, nie einen dort abgelegten Schlüssel (Codex f9e2e163).
rm -f "$DW_HOME/key/release_agent" "$DW_HOME/key/release_agent.pub" 2>/dev/null
rmdir "$DW_HOME/key" 2>/dev/null || true
rotate_log

# ---------------------------------------------------------------- Sperre
# mkdir ist atomar; in der Sperre stehen PID und Startzeit des Prozesses (gegen
# wiederverwendete PIDs). Kein pgrep -f (trifft die eigene Kommandozeile).
proc_start() { LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//;s/ *$//'; }   # LC_ALL: gleiches Format in Terminal und launchd
acquire_lock() {
  local tries=0 pid started ts age
  while ! mkdir "$LOCK" 2>/dev/null; do
    tries=$((tries + 1))
    [[ "$tries" -le 6 ]] || { log "Sperre $LOCK nicht zu übernehmen — Abbruch"; return 1; }
    pid="$(sed -n 1p "$LOCK/pid" 2>/dev/null)"
    started="$(sed -n 2p "$LOCK/pid" 2>/dev/null)"
    ts="$(sed -n 3p "$LOCK/pid" 2>/dev/null)"
    # Unvollständiger Eintrag: der Vorlauf schreibt vielleicht gerade — kurz
    # warten; bleibt er unvollständig, ist die Sperre verwaist (Codex 1ab4b3f4).
    if ! [[ "$pid" =~ ^[0-9]+$ && "$ts" =~ ^[0-9]+$ ]]; then
      if [[ "$tries" -lt 3 ]]; then sleep 1; continue; fi
      pid=""; ts=0
    fi
    age=$(( $(date +%s) - ts ))
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && [[ "$(proc_start "$pid")" == "$started" ]]; then
      if [[ "$age" -gt "$DW_LOCK_MAX_AGE" ]]; then
        log "Vorlauf PID $pid hält die Sperre seit $((age / 60)) min (Zeitlimit $((DW_LOCK_MAX_AGE / 60)) min) — hängt? Bitte prüfen; Abbruch"
        notify_once lock-stuck "$pid" "Worker hängt seit $((age / 60)) min (PID $pid) — bitte prüfen"
      else
        log "läuft schon (PID $pid, seit $((age / 60)) min) — Abbruch"
      fi
      return 1
    fi
    log "verwaiste Sperre (PID ${pid:-?}) übernommen"
    rm -rf "$LOCK"
  done
  printf '%s\n%s\n%s\n' "$$" "$(proc_start $$)" "$(date +%s)" > "$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT
  trap 'log "abgebrochen (Signal)"; exit 1' INT TERM HUP
  state_clear lock-stuck
  return 0
}

# ---------------------------------------------------------------- Signier-Probe
key_ok() {
  local perm
  [[ -f "$KEY" && -f "$KEY.pub" ]] || { log "dev-Schlüssel $KEY (+ .pub) fehlt"; return 1; }
  if perm="$(stat -c '%a' "$KEY" 2>/dev/null)"; then :; else perm="$(stat -f '%Lp' "$KEY")"; fi
  [[ "$perm" == 600 || "$perm" == 400 ]] || { log "dev-Schlüssel $KEY muss 0600 sein (ist $perm)"; return 1; }
}
# Signiert eine Wegwerf-Datei mit dem dev-Schlüssel (eigener Namensraum, nie als
# Paket-Signatur verwendbar) und prüft die Signatur. 0 ok, 124 Zeitlimit, sonst Fehler.
probe_sign() {
  local tmp rc
  key_ok || return 2
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/dvhub-dw-probe.XXXXXX")" || return 2
  printf 'dvhub-dev-worker probe %s\n' "$(date +%s)" > "$tmp/probe"
  run_to "$DW_AGENT_TIMEOUT" ssh-keygen -Y sign -q -f "$KEY" -n dvhub-dev-worker-probe "$tmp/probe" </dev/null >"$tmp/err" 2>&1
  rc=$?
  if [[ "$rc" -eq 0 ]]; then
    printf 'probe namespaces="dvhub-dev-worker-probe" %s\n' "$(awk 'NR==1{print $1" "$2}' "$KEY.pub")" > "$tmp/allowed"
    ssh-keygen -Y verify -f "$tmp/allowed" -I probe -n dvhub-dev-worker-probe -s "$tmp/probe.sig" < "$tmp/probe" >/dev/null 2>&1 || rc=3
  else
    [[ "$rc" -ne 124 ]] && log "ssh-keygen: $(tr '\n' ' ' < "$tmp/err" | cut -c1-200)"
  fi
  rm -rf "$tmp"
  return "$rc"
}
sign_ok() {
  local rc
  probe_sign; rc=$?
  case "$rc" in
    0) [[ -n "$(state_get sign-blocked)" ]] && log "dev-Schlüssel signiert wieder"
       state_clear sign-blocked; return 0 ;;
    124) log "Signieren hängt: nicht binnen ${DW_AGENT_TIMEOUT}s (Schlüssel mit Passphrase?) — nächster Versuch beim nächsten Lauf"
         notify_once sign-blocked timeout "Signieren mit dem dev-Schlüssel hängt — nächster Versuch in 10 min" ;;
    *) log "Signieren mit dem dev-Schlüssel fehlgeschlagen (rc $rc) — nächster Versuch beim nächsten Lauf"
       notify_once sign-blocked "rc$rc" "Signieren mit dem dev-Schlüssel fehlgeschlagen (rc $rc)" ;;
  esac
  return 1
}

if [[ "$MODE" == probe ]]; then
  acquire_lock || exit 0
  if [[ -n "$(gh_token)" ]]; then log "GitHub-Token aus git credential: vorhanden"; else log "GitHub-Token aus git credential: FEHLT"; fi
  if sign_ok; then log "Signier-Probe: ok (dev-Schlüssel $KEY, ohne Agent)"; exit 0; fi
  exit 1
fi

# ---------------------------------------------------------------- Repo
ensure_repo() {
  if [[ ! -d "$REPO/.git" ]]; then
    log "lege eigenen Klon an: $REPO"
    rm -rf "$REPO.tmp"
    GIT_TERMINAL_PROMPT=0 run_to "$DW_NET_TIMEOUT" git clone -q --no-checkout "$DW_ORIGIN" "$REPO.tmp" >/dev/null 2>&1 \
      || { log "git clone $DW_ORIGIN fehlgeschlagen"; rm -rf "$REPO.tmp"; return 1; }
    mv "$REPO.tmp" "$REPO"
  fi
  local url; url="$(git -C "$REPO" config --get remote.origin.url)"
  [[ "$url" == "$DW_ORIGIN" ]] || { log "Klon $REPO zeigt auf $url statt $DW_ORIGIN — Abbruch"; return 1; }
  GIT_TERMINAL_PROMPT=0 run_to "$DW_NET_TIMEOUT" git -C "$REPO" fetch -q --prune --no-tags origin \
      '+refs/heads/main:refs/remotes/origin/main' >/dev/null 2>&1 \
    || { log "git fetch origin main fehlgeschlagen (Netz?) — nächster Versuch beim nächsten Lauf"; return 1; }
}
checkout() {  # $1 = SHA; nur im eigenen Klon
  git -C "$REPO" checkout -q --detach -f "$1" && git -C "$REPO" clean -qfdx
}

# ---------------------------------------------------------------- Übergang / veröffentlicht?
# Vertrauensdatei, wie sie die Boxen mit main bekommen.
main_trust() { git -C "$REPO" show refs/remotes/origin/main:release-keys/allowed_signers 2>/dev/null; }
# Steht der dev-Schlüssel mit (genau) den dev-Namensräumen in main? Sonst nähmen
# Boxen seine Pakete nicht an.
dev_key_trusted() {
  local pub; pub="$(awk 'NR==1{print $2}' "$KEY.pub" 2>/dev/null)"
  [[ -n "$pub" ]] || return 1
  main_trust | grep -v '^#' | grep -F "$pub" | grep -F 'namespaces="dvhub-release-dev,dvhub-release-index-dev"' >/dev/null
}
gh_release_json() {  # <tag> <ziel>; fehlt das Release (404) → leere Liste
  local err; err="$(mktemp "${TMPDIR:-/tmp}/dvhub-dw-err.XXXXXX")"
  if ! api_get "/repos/$GH_REPO/releases/tags/$1" "$2" 2>"$err"; then
    if grep -q ' 404' "$err"; then echo '{"assets":[]}' > "$2"
    else log "GitHub-API nicht abfragbar ($(tr '\n' ' ' < "$err" | cut -c1-160))"; rm -f "$err"; return 1; fi
  fi
  rm -f "$err"
}
# Ausgabe: "nobridge" (index-dev-v2.json gibt es noch nicht — Übergang fehlt),
# "yes <version>", "partial <version>" (Assets ohne gültigen Index-Eintrag oder
# unvollständig) oder "no"; Rückgabe 1, wenn GitHub nicht abfragbar ist.
# Der Index zählt nur mit passender Signatur, geprüft gegen die Vertrauensdatei
# aus main mit den Namensräumen der Box (dvhub-release.cjs indexNamespaces('dev')).
remote_status() {  # $1 = SHA
  local sha="$1" tmp rc idx_ok=0 ns
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/dvhub-dw-gh.XXXXXX")" || return 1
  gh_release_json dev "$tmp/dev.json" && gh_release_json dev-bridge "$tmp/bridge.json" || { rm -rf "$tmp"; return 1; }
  if ! curl -fsSL --max-time 60 -H 'User-Agent: dvhub-dev-worker' -o "$tmp/index.json" \
      "$DW_DOWNLOAD/$GH_REPO/releases/download/channels/index-dev-v2.json" 2>"$tmp/err"; then
    if grep -q ' 404' "$tmp/err"; then echo nobridge; rm -rf "$tmp"; return 0; fi
    log "Kanal-Index nicht abrufbar ($(tr '\n' ' ' < "$tmp/err" | cut -c1-160))"; rm -rf "$tmp"; return 1
  fi
  # Signatur: 404 heißt „fehlt“ (→ unvollständig, neu veröffentlichen); jeder
  # andere Fehler (Netz, 5xx) heißt „gerade nicht prüfbar“ → später (Codex 3aa7d678).
  local sig_ok=0
  if curl -fsSL --max-time 60 -H 'User-Agent: dvhub-dev-worker' -o "$tmp/index.json.sig" \
      "$DW_DOWNLOAD/$GH_REPO/releases/download/channels/index-dev-v2.json.sig" 2>"$tmp/err"; then
    sig_ok=1
  elif ! grep -q ' 404' "$tmp/err"; then
    log "Signatur des Kanal-Index nicht abrufbar ($(tr '\n' ' ' < "$tmp/err" | cut -c1-160))"; rm -rf "$tmp"; return 1
  fi
  if [[ "$sig_ok" -eq 1 ]] && main_trust > "$tmp/allowed"; then
    for ns in dvhub-release-index-dev dvhub-release-index; do
      ssh-keygen -Y verify -f "$tmp/allowed" -I dvhub-release -n "$ns" -s "$tmp/index.json.sig" \
        < "$tmp/index.json" >/dev/null 2>&1 && { idx_ok=1; break; }
    done
  fi
  node -e '
    const fs = require("fs");
    const [devF, bridgeF, idxF, sha, archs, idxOk] = process.argv.slice(1);
    const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
    const idx = read(idxF);
    const short = sha.slice(0, 8);
    const byTag = { dev: new Set((read(devF).assets || []).map((a) => a.name)), "dev-bridge": new Set((read(bridgeF).assets || []).map((a) => a.name)) };
    const names = new Set([...byTag.dev, ...byTag["dev-bridge"]]);
    const re = new RegExp(`^dvhub-(.+\\.${short})-([a-z0-9]+)\\.tar\\.gz$`);
    let version = "";
    for (const n of names) { const m = n.match(re); if (m) version = m[1]; }
    const listed = (idx.releases || []).find((r) => r.git_sha === sha);
    if (listed) version = listed.version;
    const inIndex = listed && idxOk === "1";
    if (!version) { console.log("no"); process.exit(0); }
    // Steht der Stand im Index, zählt das Release, auf das seine URLs zeigen
    // (so lädt die Box) — nicht irgendeines (Codex f9e2e163).
    const at = (url) => { const m = /^\.\.\/([^/]+)\/([^/]+)$/.exec(url || ""); return !!m && !!byTag[m[1]] && byTag[m[1]].has(m[2]); };
    const complete = listed
      ? archs.split(",").every((a) => at(listed.artifacts?.[a]?.url) && at(listed.artifacts?.[a]?.sig))
      : archs.split(",").every((a) => names.has(`dvhub-${version}-${a}.tar.gz`) && names.has(`dvhub-${version}-${a}.tar.gz.sig`));
    console.log(`${complete && inIndex ? "yes" : "partial"} ${version}`);
  ' "$tmp/dev.json" "$tmp/bridge.json" "$tmp/index.json" "$sha" "$DW_ARCHS" "$idx_ok"
  rc=$?
  rm -rf "$tmp"
  return "$rc"
}

# ---------------------------------------------------------------- Aufräumen
prune_builds() {  # nur eigene Build-Ordner unter $OUT, die neuesten $DW_KEEP_BUILDS bleiben
  local n=0 d
  # shellcheck disable=SC2045
  for d in $(ls -1t "$OUT" 2>/dev/null); do
    [[ -d "$OUT/$d" && "$d" == *-dev.* ]] || continue   # nur dev-Build-Ordner des Workers
    [[ -e "$OUT/$d/channels-restore" && ! -f "$OUT/$d/channels-restore/bestaetigt" ]] && continue   # offenes Wiederherstellungs-Paar: nie löschen
    n=$((n + 1))
    [[ "$n" -le "$DW_KEEP_BUILDS" ]] && continue
    rm -rf "${OUT:?}/$d"
  done
  n=0
  for d in $(ls -1t "$DW_HOME/dry" 2>/dev/null); do
    [[ -d "$DW_HOME/dry/$d" && "$d" == *-dev.* ]] || continue
    n=$((n + 1))
    [[ "$n" -le "$DW_KEEP_BUILDS" ]] && continue
    rm -rf "${DW_HOME:?}/dry/$d"
  done
  for d in $(ls -1t "$RUNS" 2>/dev/null | tail -n +31); do rm -f "${RUNS:?}/$d"; done
}

fail_count() { local v; v="$(state_get "fails-$1")"; echo "${v:-0}"; }
count_fail() {  # $1 = SHA, $2 = Text; meldet beim ersten und beim letzten Versuch
  local n; n=$(( $(fail_count "$1") + 1 ))
  state_set "fails-$1" "$n"
  if [[ "$n" -ge "$DW_MAX_FAILS" ]]; then
    log "$2 — $n. Versuch, gebe für ${1:0:8} auf (erst ein neuer main-Commit oder rm \"$STATE/fails-$1\" startet neu)"
    notify "$2 — aufgegeben nach $n Versuchen (${1:0:8})"
  else
    log "$2 — Versuch $n/$DW_MAX_FAILS, nächster beim nächsten Lauf"
    [[ "$n" -eq 1 ]] && notify "$2 (${1:0:8}) — neuer Versuch in 10 min"
  fi
}

# ---------------------------------------------------------------- Lauf
main() {
  acquire_lock || return 0
  ensure_repo || return 1

  local sha short status version rc runlog build pubdest
  if [[ "$MODE" == dry && -n "$DRY_REF" ]]; then
    sha="$(git -C "$REPO" rev-parse --verify --quiet "$DRY_REF^{commit}")" \
      || { log "Ref $DRY_REF im Worker-Klon nicht gefunden"; return 1; }
    git -C "$REPO" merge-base --is-ancestor "$sha" refs/remotes/origin/main \
      || { log "${sha:0:8} liegt nicht auf origin/main — nur main-Commits"; return 1; }
  else
    sha="$(git -C "$REPO" rev-parse --verify --quiet refs/remotes/origin/main)" || { log "origin/main fehlt im Klon"; return 1; }
  fi
  short="${sha:0:8}"

  key_ok || { notify_once key-missing "$KEY" "dev-Schlüssel fehlt oder hat falsche Rechte — siehe Log"; return 1; }
  state_clear key-missing
  status="$(remote_status "$sha")" || return 1
  version="${status#* }"
  # Übergang (docs/release-pakete.md, „dev-Schlüssel“): erst wenn main den
  # dev-Schlüssel kennt UND die Brücke veröffentlicht ist (index-dev-v2.json
  # steht), veröffentlicht der Worker. Sonst fände kein Paket zu Boxen mit
  # älterem Prüfcode. Trockenläufe gehen trotzdem.
  local transition=""
  dev_key_trusted || transition="release-keys/allowed_signers von main enthält den dev-Schlüssel ($KEY.pub) nicht"
  [[ -z "$transition" && "$status" == nobridge ]] && transition="index-dev-v2.json fehlt — das Brücken-Paket (Release-Schlüssel) ist noch nicht veröffentlicht"
  if [[ -n "$transition" ]]; then
    if [[ "$MODE" != dry ]]; then
      log "main $short: Übergang zum dev-Schlüssel fehlt: $transition — nichts zu tun"
      notify_once transition-pending "$transition" "dev-Paket wartet auf den Übergang (Brücke) — siehe Log"
      return 0
    fi
    log "Übergang fehlt ($transition) — Trockenlauf baut trotzdem"
  else
    state_clear transition-pending
  fi
  if [[ "$status" == yes* ]]; then
    if ! grep -q "^$sha " "$STATE/published" 2>/dev/null; then
      [[ "$MODE" != dry ]] && printf '%s %s %s extern\n' "$sha" "$version" "$(date -u +%FT%TZ)" >> "$STATE/published"
      log "main $short: $version schon veröffentlicht (nicht durch den Worker)$([[ "$MODE" != dry ]] && echo ' — Zustand nachgetragen'), nichts zu tun"
    else
      log "main $short: $version schon veröffentlicht — nichts zu tun"
    fi
    [[ "$MODE" == dry ]] || return 0
    log "Trockenlauf baut trotzdem"
  elif [[ "$status" != nobridge ]] && grep -q "^$sha " "$STATE/published" 2>/dev/null; then
    log "main $short: laut Zustand veröffentlicht, am Release dev aber ${status%% *} — baue und veröffentliche erneut"
  elif [[ "$status" == partial* ]]; then
    log "main $short: $version nur teilweise am Release dev (Assets/Index unvollständig) — veröffentliche erneut"
  fi

  if [[ "$MODE" != dry && "$(fail_count "$sha")" -ge "$DW_MAX_FAILS" ]]; then
    log "main $short: nach $(fail_count "$sha") Fehlversuchen aufgegeben — wartet auf neuen main-Commit"
    return 0
  fi

  # publish-release legt nach gescheitertem Umstellen UND Wiederherstellen das alte
  # Index-Paar unter <build>/channels-restore ab. build-release löscht beim Neubau
  # derselben Version den ganzen Ordner — darum dann nichts automatisch, bis das
  # Paar von Hand zurück am Release ist und der Ordner entfernt (Codex 1ab4b3f4).
  # Mit der Marke „bestaetigt“ hat publish-release das alte Paar selbst
  # zurückgebracht — dann geht es weiter (Codex 3aa7d678).
  local restore="" d
  for d in "$OUT"/*/channels-restore; do
    [[ -d "$d" && ! -f "$d/bestaetigt" ]] && { restore="$d"; break; }
  done
  if [[ -n "$restore" ]]; then
    log "Wiederherstellungs-Paar liegt in $restore (publish-release konnte den Kanal-Index nicht umstellen) — erst von Hand hochladen (siehe Bau-Protokoll), dann den Ordner entfernen; bis dahin baut der Worker nichts"
    notify_once restore-pending "$restore" "Kanal-Index braucht Handarbeit — Worker angehalten (siehe Log)"
    return 1
  fi
  state_clear restore-pending

  # Klon auf origin/main (Werkzeuge, ci-check.py); gebaut wird $sha per git archive.
  checkout refs/remotes/origin/main || { log "Checkout origin/main im Worker-Klon fehlgeschlagen"; return 1; }
  local tools="${DW_TOOLS:-$REPO}"

  local ci_out
  ci_out="$(cd "$REPO" && run_to 120 "$DW_PYTHON" scripts/ci-check.py "$sha" 2>&1)"; rc=$?
  case "$rc" in
    0) state_clear ci-red ;;
    1) log "main $short: CI rot — nichts gebaut ($(printf '%s' "$ci_out" | head -1))"
       notify_once ci-red "$sha" "CI rot für main $short — kein dev-Paket"
       return 0 ;;
    3) log "main $short: CI läuft noch bzw. kein Lauf — später"; return 0 ;;
    *) log "main $short: CI-Abfrage nicht möglich (rc $rc: $(printf '%s' "$ci_out" | head -1)) — später"; return 0 ;;
  esac

  # Angehalten (Datei $STATE/sign-paused): kein Bau, keine Veröffentlichung.
  # Christin 24.11.2026: bis der Übergang zum dev-Schlüssel steht. Wieder an:
  # rm "$STATE/sign-paused".
  # Trockenläufe signieren nur mit dem dev-Schlüssel und veröffentlichen nichts — sie laufen trotzdem.
  if [[ -f "$STATE/sign-paused" && "$MODE" == dry ]]; then
    log "Worker angehalten ($STATE/sign-paused) — Trockenlauf läuft trotzdem"
  elif [[ -f "$STATE/sign-paused" ]]; then
    log "main $short: CI grün, Signieren pausiert ($STATE/sign-paused: $(head -1 "$STATE/sign-paused")) — kein dev-Paket"
    notify_once sign-paused-note "$sha" "main $short ist grün — dev-Paket wartet (Signieren pausiert)"
    return 0
  fi
  sign_ok || return 1

  runlog="$RUNS/$(date +%Y%m%d-%H%M%S)-$short.log"
  log "main $short: CI grün — baue dev-Paket ($DW_ARCHS), Protokoll $runlog"
  if [[ -z "${DOCKER_HOST:-}" && -S "$HOME/.colima/default/docker.sock" ]]; then
    export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
  fi
  run_to "$DW_BUILD_TIMEOUT" bash "$tools/scripts/release/build-release.sh" "$sha" --repo "$REPO" \
      --arch "$DW_ARCHS" --out "$OUT" --sig-scope dev --key "$KEY" </dev/null >>"$runlog" 2>&1
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    [[ "$rc" -eq 124 ]] && log "Bau nach ${DW_BUILD_TIMEOUT}s abgebrochen (Zeitlimit)"
    if [[ "$MODE" == dry ]]; then log "Bau fehlgeschlagen (rc $rc) — $runlog"; return 1; fi
    count_fail "$sha" "Bau von $short fehlgeschlagen (rc $rc, $runlog)"
    return 1
  fi
  build="$(ls -1dt "$OUT"/*."$short" 2>/dev/null | head -1)"
  [[ -n "$build" && -f "$build/release.json" ]] || { log "Bau meldet Erfolg, aber $OUT/*.$short/release.json fehlt"; return 1; }
  version="$(basename "$build")"
  [[ "$version" == *-dev.* ]] || { log "$version ist kein dev-Stand — Abbruch (nie stable)"; return 1; }

  if [[ "$MODE" == dry ]]; then
    pubdest="$DW_HOME/dry/$version"
    rm -rf "$pubdest"
    mkdir -p "$pubdest/channels"
    # Lebenden index-dev-v2.json als Vorgänger in den Trockenlauf legen; vor der
    # Brücke gibt es ihn nicht — dann ein leerer Platzhalter (nur hier).
    if ! curl -fsSL --max-time 60 -H 'User-Agent: dvhub-dev-worker' -o "$pubdest/channels/index-dev-v2.json" \
        "$DW_DOWNLOAD/$GH_REPO/releases/download/channels/index-dev-v2.json" 2>/dev/null; then
      printf '{"format":1,"channel":"dev","latest":null,"releases":[]}\n' > "$pubdest/channels/index-dev-v2.json"
      log "Trockenlauf: index-dev-v2.json gibt es noch nicht — leerer Platzhalter als Vorgänger"
    fi
    run_to "$DW_PUBLISH_TIMEOUT" bash "$tools/scripts/release/publish-release.sh" "$build" --repo "$REPO" \
        --sig-scope dev --key "$KEY" --dry-run --dest "$pubdest" </dev/null >>"$runlog" 2>&1
    rc=$?
    if [[ "$rc" -eq 0 ]]; then log "Trockenlauf ok: $version gebaut und signiert, publish-release --dry-run → $pubdest"
    else log "Trockenlauf: publish-release --dry-run fehlgeschlagen (rc $rc) — $runlog"; fi
    prune_builds
    return "$rc"
  fi

  # Nur das echte Repo — ein umgebogener Klon darf nie ins Release dev.
  if [[ "$DW_ORIGIN" != "$CANON_ORIGIN" && -z "${DVHUB_DW_TEST:-}" ]]; then
    log "Klon-Quelle $DW_ORIGIN ist nicht $CANON_ORIGIN — veröffentliche nicht"; return 1
  fi
  # Kurz vor dem Hochladen: hat es inzwischen jemand von Hand veröffentlicht?
  status="$(remote_status "$sha")" || return 1
  if [[ "$status" == yes* ]]; then
    log "main $short: inzwischen von Hand veröffentlicht — lade nichts hoch"
    printf '%s %s %s extern\n' "$sha" "${status#* }" "$(date -u +%FT%TZ)" >> "$STATE/published"
    prune_builds; return 0
  fi

  local tok; tok="$(gh_token)"
  [[ -n "$tok" ]] || { count_fail "$sha" "kein GitHub-Token aus git credential fill"; return 1; }
  log "main $short: veröffentliche $version"
  GH_TOKEN="$tok" run_to "$DW_PUBLISH_TIMEOUT" bash "$tools/scripts/release/publish-release.sh" "$build" --repo "$REPO" \
      --sig-scope dev --key "$KEY" </dev/null >>"$runlog" 2>&1
  rc=$?
  tok=""
  if [[ "$rc" -ne 0 ]]; then
    count_fail "$sha" "Veröffentlichen von $version fehlgeschlagen (rc $rc, $runlog)"
    return 1
  fi
  status="$(remote_status "$sha")" || status="unbekannt"
  if [[ "$status" != yes* ]]; then
    count_fail "$sha" "publish-release meldet Erfolg, GitHub zeigt $version aber nicht vollständig ($status)"
    return 1
  fi
  printf '%s %s %s worker\n' "$sha" "$version" "$(date -u +%FT%TZ)" >> "$STATE/published"
  state_clear "fails-$sha"
  log "main $short: $version veröffentlicht (Release dev + channels/index-dev-v2.json)"
  notify "$version veröffentlicht (Bleeding Edge)"
  prune_builds
  return 0
}

main
