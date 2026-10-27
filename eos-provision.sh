#!/usr/bin/env bash
# eos-provision.sh -- Idempotent provisioning of Akkudoktor-EOS for DVhub.
#
# Single source of truth for the EOS install, SHARED by install.sh (fresh
# install) and post-update.sh (retrofit on existing boxes) so the two never
# drift -- same pattern as support-provision.sh. Must be run as root.
#
# Honours the operator opt-out marker $DATA_DIR/.no-eos. KEIN RAM-Gate mehr
# (Christin 2026-09-20): EOS kommt immer mit -- die Container-Arbeit hat den
# Speicherbedarf entschaerft, und Boxen unter 1 GB sind die Ausnahme.
# Idempotent: clone-or-fetch den gepinnten Stand, venv-if-missing, pip
# re-resolve, systemd-Unit neu schreiben, eos.service (neu)starten.
# Der zuletzt erfolgreich installierte Pin landet in $DATA_DIR/.eos-provisioned,
# damit post-update.sh eine Versionsaenderung ohne Netzzugriff erkennt.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/dvhub}"
SERVICE_USER="${SERVICE_USER:-dvhub}"
DATA_DIR="${DATA_DIR:-${DV_DATA_DIR:-/var/lib/dvhub}}"
EOS_DIR="${EOS_DIR:-$INSTALL_DIR/eos}"
EOS_VENV="${EOS_VENV:-$INSTALL_DIR/eos-venv}"
# Akkudoktor-EOS 0.4, unveraendert (seit 2026-10-11; vorher der eigene Fork
# DV-EOS). DVhub unterstuetzt nur EOS 0.4 (GENETIC-Engine). Ein aelterer Stand
# (Fork, 0.3-Branch „dvhub-fork“) wird beim naechsten Update automatisch
# ersetzt. Override repo/ref via env.
# Gewuenschter Stand: eos-version.env im Repo ist die einzige Quelle. Env-
# Variablen gewinnen weiterhin (Tests, Sonderfaelle). EOS_BRANCH bleibt als
# Alias erhalten, damit bestehende Aufrufe nicht brechen.
EOS_PIN_FILE="${EOS_PIN_FILE:-$INSTALL_DIR/eos-version.env}"
if [[ -f "$EOS_PIN_FILE" ]]; then
  # Nur die zwei erwarteten Schluessel lesen -- die Datei wird NICHT gesourct,
  # damit ein Tippfehler darin keinen Code ausfuehrt.
  _pin_repo="$(grep -E '^EOS_REPO_URL=' "$EOS_PIN_FILE" | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r')"
  _pin_ref="$(grep -E '^EOS_PIN=' "$EOS_PIN_FILE" | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r')"
fi
EOS_REPO_URL="${EOS_REPO_URL:-${_pin_repo:-https://github.com/Akkudoktor-EOS/EOS.git}}"
EOS_PIN="${EOS_PIN:-${EOS_BRANCH:-${_pin_ref:-v0.4.0rc3}}}"
EOS_BRANCH="$EOS_PIN"   # Rueckwaertskompatibler Alias
EOS_STATE_MARKER="${EOS_STATE_MARKER:-$DATA_DIR/.eos-provisioned}"
# Dienstname und Port sind ueberschreibbar, damit eine zweite Instanz (A/B-Test
# einer neuen EOS-Version neben der laufenden) mit demselben Skript entsteht.
EOS_SERVICE_NAME="${EOS_SERVICE_NAME:-eos}"
EOS_PORT="${EOS_PORT:-8503}"
# Eigener Konfig-/Datenordner (EOS liest ihn aus EOS_DIR). Leer = EOS-Default
# (~/.local/share/net.akkudoktor.eos) wie bisher. Eine ZWEITE Instanz braucht
# ihn zwingend — sonst teilen sich beide Konfiguration und Messreihen.
EOS_HOME="${EOS_HOME:-}"
# Betreiber-Einstellungen fuer EOS (z.B. EOS_INVERTER_EFF_CURVE). Die Unit wird
# bei jeder Provisionierung neu geschrieben; was dort von Hand ergaenzt wurde,
# ging bisher dabei verloren. Diese Datei bleibt stehen.
EOS_ENV_FILE="${EOS_ENV_FILE:-/etc/dvhub/eos.env}"
EOS_BACKUP_ROOT="${EOS_BACKUP_ROOT:-$DATA_DIR/eos-backups}"

# EOS_PROVISION_EUID: nur fuer Tests (test/eos-provision-git.test.js).
if [[ "${EOS_PROVISION_EUID:-$EUID}" -ne 0 ]]; then
  echo "  EOS: eos-provision.sh muss als root laufen — uebersprungen" >&2
  exit 1
fi

# Operator opt-out (set by install.sh --no-eos). Persistent across updates.
if [[ -f "$DATA_DIR/.no-eos" ]]; then
  echo "  EOS: Uebersprungen (.no-eos Opt-out-Marker in $DATA_DIR)"
  exit 0
fi

# KEIN RAM-Gate (Christin 2026-09-20). Frueher sprang die Provisionierung unter
# 1 GB ab; das kostete genau den Boxen EOS, die es am ehesten brauchen. Wer es
# nicht will, setzt weiterhin $DATA_DIR/.no-eos.

# Checkout und venv root-eigen, bevor root daraus etwas ausfuehrt (frueher
# gehoerten sie dem Dienstbenutzer — Review 25.10.2026).
eos_root_own() {
  local d
  for d in "$EOS_DIR" "$EOS_VENV"; do
    [[ -e "$d" ]] || continue
    chown -R 0:0 "$d" && chmod -R go-w,a+rX "$d"
  done
}
eos_root_own

# Konnektivitaets-Vorpruefung. Kostet eine Sekunde und erspart im Fehlerfall
# stundenlanges Raetseln: kuendigt die Box globales IPv6 an, ohne es erreichen
# zu koennen, laeuft JEDE pip-Verbindung erst in den IPv6-Timeout -- der Download
# dauert dann Stunden statt Minuten (auf der Testbox gemessen: 30-s-Timeout je
# Verbindung gegen 1 s mit IPv4). curl faellt schnell zurueck, urllib/pip nicht.
# Wir aendern hier NICHTS am System, wir sagen nur, was los ist.
if command -v ip >/dev/null 2>&1 && ip -6 route show default 2>/dev/null | grep -q .; then
  if ! timeout 6 python3 -c "import socket;socket.create_connection(('pypi.org',443),4)" >/dev/null 2>&1; then
    echo "  EOS: WARNUNG — die Box hat eine IPv6-Default-Route, erreicht pypi.org darueber aber nicht." >&2
    echo "  EOS: Der pip-Download laeuft dann in jede Verbindung erst einen Timeout und dauert ein Vielfaches." >&2
    echo "  EOS: Abhilfe: 'precedence ::ffff:0:0/96  100' in /etc/gai.conf eintragen (IPv4 bevorzugen)." >&2
  fi
fi

EOS_WANT="${EOS_REPO_URL}@${EOS_PIN}"
EOS_HAVE="$(cat "$EOS_STATE_MARKER" 2>/dev/null || true)"
if [[ "$EOS_HAVE" == "$EOS_WANT" ]]; then
  EOS_PIN_CHANGED=0
else
  EOS_PIN_CHANGED=1
  [[ -n "$EOS_HAVE" ]] && echo "  EOS: Versionswechsel ${EOS_HAVE} -> ${EOS_WANT}"
fi

echo "  EOS: Installiere/aktualisiere EOS (${EOS_PIN}) bare-metal venv..."

# Idempotent clone / fetch auf den gepinnten Stand. Funktioniert fuer Tag,
# Branch und Commit-SHA gleichermassen, weil ueber FETCH_HEAD ausgecheckt wird.
# Der lokale Arbeitszweig heisst immer dvhub-eos -- so bleibt der Name stabil,
# auch wenn der Pin von einem Branch auf einen Tag wechselt.
#
# git als root in einem Ordner, der (noch) einem anderen Benutzer gehoert,
# bricht mit "dubious ownership" ab (safe.directory). Unter systemd-run war
# darum frueher jeder git-Aufruf hier wirkungslos: die Sicherung lokaler
# Aenderungen lief ins Leere (Review 25.10.2026). safe.directory gilt nur fuer
# genau diesen Ordner; Hooks und fsmonitor bleiben dabei aus.
# Aeltere git-Versionen (Debian 12: 2.39) vergleichen safe.directory mit dem
# physischen Pfad — darum zusaetzlich der aufgeloeste Pfad (Symlink, //).
eos_git() {
  local phys
  phys="$(cd "$EOS_DIR" 2>/dev/null && pwd -P || echo "$EOS_DIR")"
  git -c safe.directory="$EOS_DIR" -c safe.directory="$phys" -c core.hooksPath=/dev/null \
    -c core.fsmonitor=false -c advice.detachedHead=false -C "$EOS_DIR" "$@"
}

# Frisch klonen, aber erst in einen Nachbarordner. Der bisherige Stand wird erst
# ersetzt, wenn der neue Klon genau den Pin enthaelt (Review 25.10.2026: vorher
# kam `rm -rf $EOS_DIR` zuerst). Ein Pin, den es upstream nicht gibt, ist ein
# Fehler — frueher wurde still der upstream-HEAD installiert und als Pin
# eingetragen.
eos_clone_fresh() {
  local parent tmp
  parent="$(dirname "$EOS_DIR")"
  mkdir -p "$parent"
  tmp="$(mktemp -d "$parent/.eos-clone.XXXXXX")" || return 1
  local g=(git -c safe.directory="$tmp/eos" -c core.hooksPath=/dev/null -c advice.detachedHead=false -C "$tmp/eos")
  if git init -q "$tmp/eos" \
     && "${g[@]}" remote add origin "$EOS_REPO_URL" \
     && "${g[@]}" fetch -q --depth 1 origin "$EOS_PIN" \
     && "${g[@]}" checkout -q -B dvhub-eos FETCH_HEAD; then
    # Lokale Aenderungen und Daten des alten Stands erst jetzt sichern —
    # direkt vor dem Ersetzen, nicht bei jedem gescheiterten Versuch.
    # Unlesbar oder Sicherung gescheitert → abbrechen, alter Stand bleibt.
    if [[ -d "$EOS_DIR/.git" ]] && ! eos_backup_local_changes; then
      rm -rf "$tmp"
      return 1
    fi
    if ! eos_backup_data; then
      rm -rf "$tmp"
      return 1
    fi
    [[ -e "$EOS_DIR" ]] && mv "$EOS_DIR" "$tmp/old"
    mv "$tmp/eos" "$EOS_DIR"
    rm -rf "$tmp"
    return 0
  fi
  rm -rf "$tmp"
  echo "  EOS: ${EOS_REPO_URL}@${EOS_PIN} nicht abrufbar (Pin vorhanden? Netz?) — vorhandener Stand bleibt" >&2
  return 1
}

# Lokale Aenderungen im EOS-Ordner (von Hand eingespielte Patches) sichern,
# bevor irgendetwas sie ueberschreiben kann. Bisher gingen sie still verloren:
# `checkout -B … FETCH_HEAD` nahm sie entweder ungefragt auf den neuen Stand mit
# oder scheiterte — und dann loeschte eos_clone_fresh den ganzen Ordner (prod
# 2026-09-21: 725 Zeilen, nur per Zufall wiederhergestellt).
eos_backup_local_changes() {
  # Jeder Schritt mit eigenem `|| return 1` (Gegenpruefung 25.10.2026): die
  # Funktion laeuft in `||`/`if`, dort wirkt `set -e` NICHT — ein volles
  # Ziel haette sonst "gesichert" gemeldet, und reset/rm haetten die Patches
  # danach geloescht.
  local dirty untracked dest f
  # Je Lauf nur einmal (Gegenpruefung 3c860448): scheitert nach der ersten
  # Sicherung der Checkout und es wird neu geklont, ist der Baum nach dem
  # reset sauber — eine zweite Sicherung in derselben Sekunde ueberschrieb den
  # Patch mit einem leeren.
  [[ "${EOS_LOCAL_BACKED_UP:-0}" -eq 1 ]] && return 0
  # Scheitert git hier, ist der Zustand UNBEKANNT, nicht "sauber": dann nichts
  # ersetzen (sonst gingen lokale Patches ungesichert mit dem alten Ordner weg).
  if ! dirty="$(eos_git status --porcelain --untracked-files=no 2>/dev/null)" \
     || ! untracked="$(eos_git ls-files --others --exclude-standard 2>/dev/null)"; then
    echo "  EOS: Zustand von $EOS_DIR nicht lesbar (git status) — nichts geaendert" >&2
    return 1
  fi
  [[ -n "$dirty" || -n "$untracked" ]] || return 0
  dest="$EOS_BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dest/files" || return 1
  eos_git rev-parse HEAD > "$dest/BASE_COMMIT" 2>/dev/null || true
  # gegen HEAD: auch vorgemerkte (git add) Aenderungen
  eos_git diff HEAD > "$dest/local-changes.patch" || return 1
  # Zusaetzlich die Dateien selbst — ein Patch laesst sich auf einen anderen
  # Stand oft nicht mehr anwenden, die Dateien kann man immer vergleichen.
  # Untracked Dateien gehoeren dazu: genau die stehen einem Checkout im Weg.
  # NUL-getrennt (Gegenpruefung 3c860448): sonst quotet git Namen mit
  # Umlauten ("\303\244.py"), cp scheitert, und jede Sicherung danach auch.
  { eos_git diff HEAD -z --name-only --diff-filter=d && eos_git ls-files -z --others --exclude-standard; } > "$dest/.names" || return 1
  while IFS= read -r -d '' f; do
    [[ -n "$f" ]] || continue
    mkdir -p "$dest/files/$(dirname "$f")" || return 1
    cp -p "$EOS_DIR/$f" "$dest/files/$f" || return 1
  done < "$dest/.names"
  rm -f "$dest/.names"
  EOS_LOCAL_BACKED_UP=1
  echo "  EOS: lokale Aenderungen gesichert nach $dest"
}

# Versionswechsel (z. B. 0.3-Fork -> 0.4): EOS-Konfiguration und Messreihen
# sichern, bevor der neue Stand startet. 0.4 migriert die Konfiguration beim
# Start selbst; geht dabei etwas schief, liegt der alte Stand hier.
# Erst NACH dem erfolgreichen Holen des neuen Stands und je Wechsel nur einmal
# (Gegenpruefung 25.10.2026): ein Pin, der scheitert, scheitert bei jedem
# Dienststart erneut — vorher kopierte jeder Versuch den ganzen, wachsenden
# Messwertspeicher noch einmal (SD-Karte voll). Kopie erst in <ziel>.partial,
# umbenannt erst nach Erfolg; der Marker nennt den Wechsel (von→nach, Ordner),
# damit ein spaeterer Rueckweg wieder sichert.
# Und VOR dem Umstellen des Checkouts (Gegenpruefung 3c860448): scheitert die
# Sicherung, bleibt der alte Stand vollstaendig (Checkout + venv) stehen —
# vorher war der Checkout schon neu, das venv alt, und der naechste Start lief
# ohne Sicherung in die Migration. Halbe Kopien abgebrochener Laeufe weg.
eos_backup_data() {
  local _eos_data _transition _mark _dest
  [[ "$EOS_PIN_CHANGED" -eq 1 && -n "$EOS_HAVE" ]] || return 0
  _eos_data="${EOS_HOME:-$(getent passwd "$SERVICE_USER" 2>/dev/null | cut -d: -f6 || true)/.local/share/net.akkudoktor.eos}"
  _transition="${EOS_HAVE} -> ${EOS_WANT} (${_eos_data})"
  _mark="$EOS_BACKUP_ROOT/.data-backup-${EOS_SERVICE_NAME}"
  [[ -d "$_eos_data" && "$(cat "$_mark" 2>/dev/null)" != "$_transition" ]] || return 0
  rm -rf "$EOS_BACKUP_ROOT"/*-data-before-*.partial 2>/dev/null || true
  _dest="$EOS_BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)-data-before-${EOS_PIN//\//_}"
  if mkdir -p "$_dest.partial" && cp -a "$_eos_data/." "$_dest.partial/" && mv "$_dest.partial" "$_dest"; then
    printf '%s\n' "$_transition" > "$_mark" || return 1
    echo "  EOS: Daten/Konfiguration vor dem Versionswechsel gesichert nach $_dest"
    return 0
  fi
  rm -rf "$_dest.partial"
  echo "  EOS: Sicherung der Daten vor dem Versionswechsel fehlgeschlagen — Abbruch, alter Stand bleibt" >&2
  return 1
}

if [[ ! -d "$EOS_DIR/.git" ]]; then
  eos_clone_fresh || exit 1
elif [[ "$EOS_PIN_CHANGED" -eq 0 && -n "$(eos_git status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
  # Gleicher Stand, aber lokal geaendert: nichts anfassen. Die Aenderungen sind
  # offensichtlich gewollt, und es gibt keinen neuen Stand, der sie ersetzt.
  echo "  EOS: lokale Aenderungen im EOS-Ordner, Stand unveraendert — Checkout bleibt wie er ist"
else
  # Repo-Wechsel (Fork -> upstream) mitziehen, sonst zeigt origin ins Leere.
  eos_git remote set-url origin "$EOS_REPO_URL" 2>/dev/null || true
  # Erst holen (aendert den Arbeitsbaum nicht), dann sichern und umstellen.
  if eos_git fetch -q --depth 1 origin "$EOS_PIN" 2>/dev/null; then
    # Erst jetzt sichern (der neue Stand ist da); Zustand unlesbar oder
    # Sicherung gescheitert → Abbruch, Checkout unveraendert.
    eos_backup_local_changes || exit 1
    eos_backup_data || exit 1
    # Beim Versionswechsel kommen die alten Patches NICHT mit: sie gehoeren zum
    # alten Stand und sind gesichert.
    eos_git reset --hard -q 2>/dev/null || true
    if ! eos_git checkout -q -B dvhub-eos FETCH_HEAD; then
      # z. B. eine untracked Datei im Weg: frisch klonen (ersetzt erst danach).
      echo "  EOS: Checkout auf ${EOS_PIN} nicht moeglich — klone neu"
      eos_clone_fresh || exit 1
    fi
  else
    # Ein flacher Klon kann einen Ref aus einer anderen Historie nicht
    # nachziehen -- dann frisch klonen. Der alte Stand wird erst ersetzt, wenn
    # der neue Klon steht.
    echo "  EOS: Fetch auf ${EOS_PIN} nicht moeglich — klone neu"
    eos_clone_fresh || exit 1
  fi
fi

# Python venv (Python 3.11+). Bei einem Versionswechsel wird es NEU gebaut:
# ein 0.3->0.4-Sprung tauscht die halbe Abhaengigkeitsliste aus, und ein
# gewachsenes venv traegt dann Altlasten mit, die niemand mehr aufloest.
if [[ -d "$EOS_VENV" && "$EOS_PIN_CHANGED" -eq 1 && -n "$EOS_HAVE" ]]; then
  echo "  EOS: venv wird wegen Versionswechsel neu gebaut"
  rm -rf "$EOS_VENV"
fi
[[ -d "$EOS_VENV" ]] || python3 -m venv "$EOS_VENV"
"$EOS_VENV/bin/pip" install --upgrade pip
# T-0118: EOS v0.3.0 ships pyproject.toml, NOT requirements.txt — only honour a
# requirements.txt if present; the editable install resolves deps regardless.
if [[ -f "$EOS_DIR/requirements.txt" ]]; then
  "$EOS_VENV/bin/pip" install -r "$EOS_DIR/requirements.txt"
fi
"$EOS_VENV/bin/pip" install -e "$EOS_DIR"
# Phase 18-03: starlette auf die 0.x-Linie pinnen — ABER nur dort, wo der Grund
# noch gilt. fasthtml 0.12.x (via monsterui, von EOS v0.3.0 hereingezogen) ruft
# Starlette.__init__(on_startup=…), das starlette 1.x gestrichen hat; ohne Pin
# stuerzt EOSdash bei jedem Neustart ab, waehrend die EOS-API weiterlaeuft
# (prod 2026-05-20 bei starlette 0.52.1 verifiziert).
#
# EOS 0.4 bringt fasthtml 0.14.13 mit und loest starlette 1.6.0 auf. Der alte
# Pin wuerde dort ohne Not auf 0.52.1 herunterstufen — ein Abhaengigkeitsstand,
# gegen den upstream gar nicht testet. Am 2026-09-20 auf der Testbox gemessen:
# mit starlette 1.6.0 laufen EOS (v1/health 200) UND EOSdash (HTTP 200) sauber.
# Deshalb haengt der Pin jetzt an seiner Ursache statt an der Gewohnheit.
FASTHTML_NEEDS_OLD_STARLETTE="$("$EOS_VENV/bin/python" - <<'PYEOF' 2>/dev/null || echo 1
try:
    from importlib.metadata import version
    parts = version("python-fasthtml").split(".")
    print("1" if (int(parts[0]), int(parts[1])) < (0, 14) else "0")
except Exception:
    print("1")
PYEOF
)"
if [[ "$FASTHTML_NEEDS_OLD_STARLETTE" == "0" ]]; then
  echo "  EOS: fasthtml >= 0.14 — starlette bleibt auf der von EOS aufgeloesten Version"
else
  echo "  EOS: fasthtml < 0.14 — starlette auf die 0.x-Linie pinnen (sonst stuerzt EOSdash ab)"
  "$EOS_VENV/bin/pip" install --upgrade "starlette<1.0"
fi

# Besitz: root, fuer den Dienstbenutzer nur lesbar/ausfuehrbar (Review
# 25.10.2026). root fuehrt pip/python aus dem venv und den Build aus EOS_DIR
# aus (pip install -e); gehoerten sie dem Dienstbenutzer, koennte der sie
# vorher aendern. eos.service laeuft weiter als Dienstbenutzer.
eos_root_own
if [[ -n "$EOS_HOME" ]]; then
  mkdir -p "$EOS_HOME"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$EOS_HOME"
fi

# systemd unit — bind 127.0.0.1:$EOS_PORT only (no external access).
#
# After=dvhub.service (2026-09-21): EOS rechnet 5 s nach dem Start seinen ersten
# Lauf (ems.startup_delay). Startet EOS vor DVhub, trifft dieser Lauf einen
# Prozess ohne importierte Prognosen, laeuft in die Demo-Daten und wird
# verworfen — der naechste Versuch kommt erst einen ems.interval-Tick spaeter.
# Beim Boot war das der Unterschied zwischen einem Plan nach Minuten und einem
# nach einer halben Stunde. Bewusst nur eine REIHENFOLGE (After), keine
# Abhaengigkeit (Requires/Wants): faellt DVhub aus, soll EOS trotzdem laufen.
#
# MALLOC_ARENA_MAX=2 (2026-09-25): EOS rechnet im Worker-Thread; glibc legt
# dafuer eigene Heap-Arenen an und gibt deren Seiten nach einem Lauf nicht
# zurueck. Wechselt ein Lauf die Arena, belegt er den Speicher ein zweites Mal —
# auf prod treppte EOS 0.4 so bis ans MemoryMax. Zwei Arenen reichen fuer
# Server-Loop + einen Optimierungs-Thread. Steht vor EnvironmentFile, damit der
# Betreiber es dort ueberschreiben kann.
EOS_UNIT_FILE="${EOS_UNIT_FILE:-/etc/systemd/system/${EOS_SERVICE_NAME}.service}"
EOS_TZ="$(timedatectl show -p Timezone --value 2>/dev/null || true)"; EOS_TZ="${EOS_TZ:-Europe/Berlin}"
_ncpu="$(nproc 2>/dev/null || echo 1)"
if [[ -z "${EOS_CPU_QUOTA:-}" && "$_ncpu" -ge 2 ]]; then EOS_CPU_QUOTA="$(( (_ncpu - 1) * 100 ))%"; fi
# Einmalige Uebernahme: Zusatz-Environment-Zeilen einer von Hand erweiterten
# alten Unit wandern in die Betreiberdatei, statt beim Neuschreiben zu verschwinden.
if [[ -f "$EOS_UNIT_FILE" && ! -f "$EOS_ENV_FILE" ]]; then
  _extra_env="$(grep -E '^Environment=' "$EOS_UNIT_FILE" | sed 's/^Environment=//' \
    | grep -vE '^(EOS_SERVER__(HOST|PORT|EOSDASH_PORT)|MALLOC_ARENA_MAX|PYTHONMALLOC|MALLOC_TRIM_THRESHOLD_|MALLOC_MMAP_THRESHOLD_|OPENBLAS_NUM_THREADS|OMP_NUM_THREADS|EOS_GENERAL__TIMEZONE_OVERRIDE)=' || true)"
  if [[ -n "$_extra_env" ]]; then
    mkdir -p "$(dirname "$EOS_ENV_FILE")"
    {
      echo "# Aus der alten ${EOS_SERVICE_NAME}.service uebernommen ($(date -Is))."
      echo "# Wird von eos-provision.sh nie ueberschrieben."
      printf '%s\n' "$_extra_env"
    } > "$EOS_ENV_FILE"
    chmod 644 "$EOS_ENV_FILE"
    echo "  EOS: $(printf '%s\n' "$_extra_env" | wc -l) Zusatz-Einstellungen nach $EOS_ENV_FILE uebernommen"
  fi
fi

cat <<UNIT >"$EOS_UNIT_FILE"
[Unit]
Description=Akkudoktor EOS (Energy Optimization System)
After=network.target dvhub.service

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$EOS_DIR
ExecStart=$EOS_VENV/bin/python -m akkudoktoreos.server.eos
Environment=EOS_SERVER__HOST=127.0.0.1
Environment=EOS_SERVER__PORT=$EOS_PORT
Environment=EOS_SERVER__EOSDASH_PORT=$((EOS_PORT + 1))
Environment=MALLOC_ARENA_MAX=2
# Python-Objekte über den Systemallokator, Trim-Schwellen niedrig: EOS gibt den
# Speicher eines Planungslaufs danach zurück (prod: Leerlauf 295 → 238 MB).
Environment=PYTHONMALLOC=malloc
Environment=MALLOC_TRIM_THRESHOLD_=131072
Environment=MALLOC_MMAP_THRESHOLD_=131072
# Eine Rechen-Thread-Puffer-Garnitur reicht (OpenBLAS legt sonst je Kern eigene an).
Environment=OPENBLAS_NUM_THREADS=1
Environment=OMP_NUM_THREADS=1
# Feste Zeitzone statt Nachschlagen aus Breiten-/Längengrad (spart ~25 MB; EOS ab rc1.5).
Environment=EOS_GENERAL__TIMEZONE_OVERRIDE=$EOS_TZ
EnvironmentFile=-$EOS_ENV_FILE
# EOS 0.4 rechnet einen Lauf minutenlang auf voller Last. Niedrige Prioritaet
# und hoechstens (Kerne - 1) Kerne, damit DVhub und die Regelschleife immer
# Luft haben (prod 2026-09-27: 2-Kern-Box sonst ausgelastet).
Nice=10
CPUWeight=20
${EOS_CPU_QUOTA:+CPUQuota=$EOS_CPU_QUOTA}
${EOS_HOME:+Environment=EOS_DIR=$EOS_HOME}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "${EOS_SERVICE_NAME}.service"
systemctl restart "${EOS_SERVICE_NAME}.service"

# Den tatsaechlich installierten Stand festhalten -- post-update.sh vergleicht
# ihn gegen eos-version.env und erkennt so eine neue Version ohne Netzzugriff.
# Bewusst ERST hier: bricht das Skript vorher ab, bleibt der alte Marker stehen
# und der naechste Boot versucht es erneut.
mkdir -p "$DATA_DIR"
printf '%s\n' "$EOS_WANT" > "$EOS_STATE_MARKER"
chown "$SERVICE_USER:$SERVICE_USER" "$EOS_STATE_MARKER" 2>/dev/null || true

echo "  EOS: systemd ${EOS_SERVICE_NAME}.service bereit (127.0.0.1:${EOS_PORT}), Stand ${EOS_PIN}"
