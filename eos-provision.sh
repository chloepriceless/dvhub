#!/usr/bin/env bash
# eos-provision.sh -- Idempotent provisioning of the DVhub DV-EOS fork.
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
# T-0121: install the DVhub DV-EOS *fork* (15-min slots, slot-aware
# battery/inverter math, battery->grid arbitrage export, EnergyCharts spot
# feed-in, pydantic /v1/prediction/import fix) directly from the fork branch.
# The branch carries every patch on top of upstream v0.3.0, so the legacy
# eos-patches/apply.sh step is no longer needed. Override repo/branch via env.
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
EOS_REPO_URL="${EOS_REPO_URL:-${_pin_repo:-https://github.com/chloepriceless/DV-EOS.git}}"
EOS_PIN="${EOS_PIN:-${EOS_BRANCH:-${_pin_ref:-dvhub-fork}}}"
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

if [[ "${EUID}" -ne 0 ]]; then
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
eos_clone_fresh() {
  rm -rf "$EOS_DIR"
  git clone --branch "$EOS_PIN" --depth 1 "$EOS_REPO_URL" "$EOS_DIR" 2>/dev/null \
    || git clone --depth 1 "$EOS_REPO_URL" "$EOS_DIR" \
    || { echo "  EOS: git clone ${EOS_REPO_URL}@${EOS_PIN} fehlgeschlagen" >&2; return 1; }
  git -C "$EOS_DIR" fetch --depth 1 origin "$EOS_PIN" 2>/dev/null || true
  git -C "$EOS_DIR" checkout -B dvhub-eos FETCH_HEAD 2>/dev/null || true
}

# Lokale Aenderungen im EOS-Ordner (von Hand eingespielte Patches) sichern,
# bevor irgendetwas sie ueberschreiben kann. Bisher gingen sie still verloren:
# `checkout -B … FETCH_HEAD` nahm sie entweder ungefragt auf den neuen Stand mit
# oder scheiterte — und dann loeschte eos_clone_fresh den ganzen Ordner (prod
# 2026-09-21: 725 Zeilen, nur per Zufall wiederhergestellt).
eos_backup_local_changes() {
  local dirty
  dirty="$(git -C "$EOS_DIR" status --porcelain --untracked-files=no 2>/dev/null || true)"
  [[ -n "$dirty" ]] || return 0
  local dest="$EOS_BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dest"
  git -C "$EOS_DIR" rev-parse HEAD > "$dest/BASE_COMMIT" 2>/dev/null || true
  git -C "$EOS_DIR" diff > "$dest/local-changes.patch"
  # Zusaetzlich die Dateien selbst — ein Patch laesst sich auf einen anderen
  # Stand oft nicht mehr anwenden, die Dateien kann man immer vergleichen.
  git -C "$EOS_DIR" diff --name-only | while read -r f; do
    mkdir -p "$dest/files/$(dirname "$f")"
    cp -p "$EOS_DIR/$f" "$dest/files/$f" 2>/dev/null || true
  done
  echo "  EOS: lokale Aenderungen gesichert nach $dest ($(printf '%s\n' "$dirty" | wc -l) Dateien)"
}

if [[ ! -d "$EOS_DIR/.git" ]]; then
  eos_clone_fresh || exit 1
elif [[ "$EOS_PIN_CHANGED" -eq 0 && -n "$(git -C "$EOS_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
  # Gleicher Stand, aber lokal geaendert: nichts anfassen. Die Aenderungen sind
  # offensichtlich gewollt, und es gibt keinen neuen Stand, der sie ersetzt.
  echo "  EOS: lokale Aenderungen im EOS-Ordner, Stand unveraendert — Checkout bleibt wie er ist"
else
  eos_backup_local_changes
  # Beim Versionswechsel kommen die alten Patches NICHT mit: sie gehoeren zum
  # alten Stand und sind gesichert.
  git -C "$EOS_DIR" reset --hard -q 2>/dev/null || true
  # Repo-Wechsel (Fork -> upstream) mitziehen, sonst zeigt origin ins Leere.
  git -C "$EOS_DIR" remote set-url origin "$EOS_REPO_URL" 2>/dev/null || true
  if git -C "$EOS_DIR" fetch --depth 1 origin "$EOS_PIN" 2>/dev/null \
     && git -C "$EOS_DIR" checkout -B dvhub-eos FETCH_HEAD 2>/dev/null; then
    :
  else
    # Ein flacher Klon kann einen Ref aus einer anderen Historie nicht
    # nachziehen -- dann lieber frisch klonen als halb aktualisiert stehen
    # bleiben. Der alte Stand geht dabei verloren, aber er ist reproduzierbar.
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

# Ownership: the systemd user must be able to execute the venv.
chown -R "$SERVICE_USER:$SERVICE_USER" "$EOS_VENV" "$EOS_DIR"
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
EOS_UNIT_FILE="/etc/systemd/system/${EOS_SERVICE_NAME}.service"
# Einmalige Uebernahme: Zusatz-Environment-Zeilen einer von Hand erweiterten
# alten Unit wandern in die Betreiberdatei, statt beim Neuschreiben zu verschwinden.
if [[ -f "$EOS_UNIT_FILE" && ! -f "$EOS_ENV_FILE" ]]; then
  _extra_env="$(grep -E '^Environment=' "$EOS_UNIT_FILE" | sed 's/^Environment=//' \
    | grep -vE '^EOS_SERVER__(HOST|PORT)=' || true)"
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
EnvironmentFile=-$EOS_ENV_FILE
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
