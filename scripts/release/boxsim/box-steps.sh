#!/usr/bin/env bash
# box-steps.sh — Schritte im Prüfstand-Container (als root, über docker exec).
# Gemountet: /mnt/mirror (Spiegel), /mnt/rt (Testordner mit pub-*), /mnt/out
# (Protokolle). Jeder Schritt gibt eine Zeile "RESULT key=value …" aus.
#
# Stubs (bewusst, dokumentiert in docs/release-pakete.md / Bericht):
#  - git: https://github.com/chloepriceless/dvhub.git → file:///srv/git/dvhub.git
#    per url.insteadOf (origin bleibt die offizielle URL); safe.directory nur für
#    den Spiegel.
#  - Release-Quelle: /etc/dvhub-release/release.conf base_url=http://127.0.0.1:8088
#    (lokaler Server statt GitHub), migrate_delay_s=15 statt 120.
#  - EOS: install.sh --no-eos (v1.0.0+); v0.4.2 kennt EOS nicht.
#  - Python-Prognose: /etc/pip.conf zeigt auf einen toten Index (pip scheitert
#    schnell, nicht fatal); TimescaleDB: packagecloud.io → 127.0.0.1.
#  - Ports < 1024: sysctl ip_unprivileged_port_start=0 statt Capabilities.
set -uo pipefail
export LC_ALL=C.UTF-8
OUT=/mnt/out
step="${1:-}"; shift || true
log() { echo "$(date -u +%H:%M:%S) $*"; }
result() { echo "RESULT $*"; echo "$step $*" >> "$OUT/results.txt"; }
cfg() { node -e 'try{const c=JSON.parse(require("fs").readFileSync("/etc/dvhub/config.json","utf8"));const v=c[process.argv[1]];process.stdout.write(v===undefined?"":String(v))}catch{}' "$1"; }
port() { local p; p="$(cfg httpPort)"; echo "${p:-8080}"; }
token() { cfg apiToken; }
health() { curl -s -m 5 "http://127.0.0.1:$(port)/health" || true; }
# Version aus /health. v0.4 hat kein /health: dann zählt "/" mit HTTP 200 als "ok".
hver() {
  local v
  v="$(health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.version||(j.ok===true?"ok":"")))}catch{}})')"
  if [[ -z "$v" && "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$(port)/")" == 200 ]]; then v=ok; fi
  printf '%s' "$v"
}
api() {  # <METHOD> <pfad> [json]
  local t; t="$(token)"
  curl -s -m 900 -X "$1" -H 'content-type: application/json' ${t:+-H "Authorization: Bearer $t"} \
    ${3:+-d "$3"} "http://127.0.0.1:$(port)$2"
}
now() { date +%s.%N; }
dur() { awk -v a="$1" -v b="$2" 'BEGIN{printf "%.1f", b-a}'; }

case "$step" in
  setup) # <tag> — Spiegel auf den Stand zur Zeit von <tag>, Stubs, Testserver
    tag="$1"
    mkdir -p /srv/git /srv/ctl
    rm -rf /srv/git/dvhub.git && cp -a /mnt/mirror /srv/git/dvhub.git && chown -R root:root /srv/git/dvhub.git
    g() { git -C /srv/git/dvhub.git "$@"; }
    after=0
    for t in $(g tag | sort -V); do
      if [[ "$after" -eq 1 ]]; then g update-ref "refs/hidden/$t" "refs/tags/$t"; g tag -d "$t" >/dev/null; fi
      [[ "$t" == "$tag" ]] && after=1
    done
    g update-ref refs/heads/main "$(g rev-parse "$tag^{commit}")"
    git config --system url."file:///srv/git/dvhub.git".insteadOf https://github.com/chloepriceless/dvhub.git
    git config --system --add safe.directory /srv/git/dvhub.git
    printf '[global]\nindex-url = http://127.0.0.1:9/simple\ntimeout = 2\nretries = 0\n' > /etc/pip.conf
    grep -q packagecloud /etc/hosts || echo '127.0.0.1 packagecloud.io' >> /etc/hosts
    ln -sfn /mnt/rt/pub-1 /srv/pub
    bash "$0" server >/dev/null
    result "setup=ok tags=$(g tag | wc -l) main=$(g rev-parse --short main)"
    ;;

  server) # Testserver (neu) starten — überlebt keinen Neustart des Containers
    systemctl stop release-testserver 2>/dev/null
    systemd-run --unit release-testserver --property=StandardOutput=append:/mnt/out/testserver.log \
      --property=StandardError=append:/mnt/out/testserver.log node /mnt/harness/testserver.mjs 8088 /srv/pub /srv/ctl >/dev/null
    result "server=started"
    ;;

  install) # <tag> <channel> — install.sh dieses Stands, wie beim Kunden
    tag="$1"; ch="$2"
    git -C /srv/git/dvhub.git show "$tag:install.sh" > /root/install.sh
    flags=(--channel "$ch")
    grep -q -- '--no-eos)' /root/install.sh && flags+=(--no-eos)
    t0="$(now)"
    bash /root/install.sh "${flags[@]}" > "$OUT/install-$tag.log" 2>&1
    rc=$?
    t1="$(now)"
    result "install=$rc flags='${flags[*]}' time_s=$(dur "$t0" "$t1")"
    ;;

  wait-health) # [erwartete Version (Präfix)] [timeout]
    want="${1:-}"; to="${2:-240}"; t0="$(now)"; v=""
    for _ in $(seq 1 "$to"); do
      v="$(hver)"
      if [[ -n "$v" && ( -z "$want" || "$v" == "v$want"* ) ]]; then break; fi
      sleep 1
    done
    ok=0; [[ -n "$v" && ( -z "$want" || "$v" == "v$want"* ) ]] && ok=1
    result "health=$ok version=$v waited_s=$(dur "$t0" "$(now)") active=$(systemctl is-active dvhub)"
    ;;

  seed) # Marker in Config, Daten, Datenbank, Box-Zustand
    m="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "$m" > /etc/dvhub/release-test-marker; chown dvhub:dvhub /etc/dvhub/release-test-marker
    echo "$m" > /var/lib/dvhub/release-test-marker; chown dvhub:dvhub /var/lib/dvhub/release-test-marker
    su postgres -c "psql -q -d dvhub -c \"create table if not exists release_test(v text); insert into release_test values ('$m');\"" >/dev/null 2>&1 && db=1 || db=0
    for d in forecast-venv eos-venv bin; do [[ -d "/opt/dvhub/$d" ]] && echo "$m" > "/opt/dvhub/$d/release-test-marker"; done
    cp /etc/dvhub/config.json /root/config.seed.json
    echo "$m" > /root/marker
    result "seed=ok db=$db channel=$(cfg updateChannel)"
    ;;

  reseed-state) # Box-Zustand neu markieren (die alte git-Oberfläche räumt venvs per stash weg)
    m="$(cat /root/marker)"; lost=()
    for d in forecast-venv eos-venv bin; do
      if [[ -f "/root/state-$d" && ! -f "/opt/dvhub/$d/release-test-marker" ]]; then lost+=("$d"); fi
      rm -f "/root/state-$d"
      [[ -d "/opt/dvhub/$d" ]] && echo "$m" > "/opt/dvhub/$d/release-test-marker"
    done
    # Neue Basis für den Config-Vergleich: das Versions-Update selbst darf die
    # Config migrieren (neue Schlüssel); die Umstellung auf Pakete nicht.
    upd="$(node -e '
      const fs=require("fs");const a=JSON.parse(fs.readFileSync("/root/config.seed.json","utf8"));const b=JSON.parse(fs.readFileSync("/etc/dvhub/config.json","utf8"));
      const keys=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]));process.stdout.write(keys.join(",")||"-")')"
    cp /etc/dvhub/config.json /root/config.seed.json
    result "reseed_state=ok lost_by_old_git_update='${lost[*]-}' config_migrated_by_version_update=$upd"
    ;;

  check) # <name> — Marker, Config, Kanal, Dienst
    m="$(cat /root/marker)"; bad=()
    [[ "$(cat /etc/dvhub/release-test-marker 2>/dev/null)" == "$m" ]] || bad+=(config-marker)
    [[ "$(cat /var/lib/dvhub/release-test-marker 2>/dev/null)" == "$m" ]] || bad+=(data-marker)
    if su postgres -c "psql -tA -d dvhub -c 'select 1 from pg_tables where tablename=\$\$release_test\$\$'" 2>/dev/null | grep -q 1; then
      su postgres -c "psql -tA -d dvhub -c 'select v from release_test'" 2>/dev/null | grep -q "$m" || bad+=(db-marker)
    fi
    for d in forecast-venv eos-venv bin; do
      [[ -f "/root/state-$d" || -f "/opt/dvhub/$d/release-test-marker" ]] || continue
      touch "/root/state-$d"
      [[ "$(cat "/opt/dvhub/$d/release-test-marker" 2>/dev/null)" == "$m" ]] || bad+=("state-$d")
    done
    diffkeys="$(node -e '
      const fs=require("fs");const a=JSON.parse(fs.readFileSync("/root/config.seed.json","utf8"));const b=JSON.parse(fs.readFileSync("/etc/dvhub/config.json","utf8"));
      const keys=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]));process.stdout.write(keys.join(",")||"-")')"
    for k in updateChannel apiToken httpPort manufacturer; do [[ ",$diffkeys," == *",$k,"* ]] && bad+=("config-$k"); done
    result "check=$1 ok=$([[ ${#bad[@]} -eq 0 ]] && echo 1 || echo 0) bad='${bad[*]-}' config_changed_keys=$diffkeys channel=$(cfg updateChannel) current=$(readlink /opt/dvhub/current 2>/dev/null || echo -) active=$(systemctl is-active dvhub)"
    ;;

  publish) # <pub-stand> [<main-tag>] — neue Version erscheint (Spiegel + Pakete)
    pubst="$1"; maintag="${2:-v1.0.9}"
    g() { git -C /srv/git/dvhub.git "$@"; }
    for r in $(g for-each-ref --format='%(refname:strip=2)' refs/hidden/ | sort -V); do
      [[ "$r" == v1.0.10 || "$r" == v1.0.11 ]] && continue
      g update-ref "refs/tags/$r" "refs/hidden/$r"
    done
    g update-ref refs/heads/main "$(g rev-parse "$maintag^{commit}")"
    ln -sfn "/mnt/rt/$pubst" /srv/pub
    install -d -m 0755 /etc/dvhub-release
    printf 'base_url=http://127.0.0.1:8088\nmigrate_delay_s=15\n' > /etc/dvhub-release/release.conf
    result "publish=$pubst main=$(g rev-parse --short main)"
    ;;

  pub) # <pub-stand> — nur Veröffentlichungsstand wechseln
    ln -sfn "/mnt/rt/$1" /srv/pub; result "pub=$1"
    ;;

  gui-git-update) # Update über die ALTE Oberfläche (git), wie der Kunde klickt
    t0="$(now)"
    r="$(api POST /api/admin/update/apply '{}')"
    t1="$(now)"
    echo "$r" > "$OUT/gui-git-update.json"
    ok="$(echo "$r" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).ok))}catch{process.stdout.write("parse-error")}})')"
    result "gui_git_update=$ok time_s=$(dur "$t0" "$t1") resp='$(echo "$r" | head -c 300)'"
    ;;

  manual-post-update) # dokumentierter Handgriff für v0.4.x
    bash /opt/dvhub/post-update.sh > "$OUT/manual-post-update.log" 2>&1
    result "manual_post_update=$?"
    ;;

  wait-job) # <job> [timeout] — wartet auf das Ende eines dvhub-release-Auftrags
    job="$1"; to="${2:-900}"; st=""
    for _ in $(seq 1 "$to"); do
      st="$(node -e 'try{const s=JSON.parse(require("fs").readFileSync("/var/lib/dvhub-release/status.json","utf8"));process.stdout.write(s.job+" "+s.state)}catch{}')"
      case "$st" in "$job ok"|"$job rolled_back"|"$job failed"|"$job skipped") break ;; esac
      sleep 1
    done
    node -e '
      const s=JSON.parse(require("fs").readFileSync("/var/lib/dvhub-release/status.json","utf8"));
      const d=(Date.parse(s.finished)-Date.parse(s.started))/1000;
      console.log(`RESULT job=${s.job} state=${s.state} version=${s.version||"-"} time_s=${isFinite(d)?d.toFixed(1):"-"} msg="${String(s.message).replace(/"/g,"")}"`);
    ' | tee -a "$OUT/results.txt"
    ;;

  gui-pkg-update) # [version] — Paket-Update über die NEUE Oberfläche
    body='{}'; [[ -n "${1:-}" ]] && body="{\"version\":\"$1\"}"
    r="$(api POST /api/admin/update/apply "$body")"
    echo "$r" >> "$OUT/gui-pkg.json"
    result "gui_pkg_apply='$(echo "$r" | head -c 200)'"
    ;;

  gui-rollback)
    r="$(api POST /api/admin/update/rollback)"
    result "gui_rollback='$(echo "$r" | head -c 200)'"
    ;;

  gui-check)
    r="$(api GET /api/admin/update/check)"
    echo "$r" >> "$OUT/gui-check.json"
    result "gui_check='$(echo "$r" | head -c 400)'"
    ;;

  gui-status)
    r="$(api GET /api/admin/update/status)"
    result "gui_status='$(echo "$r" | head -c 300)'"
    ;;

  ctl) # <datei> on|off — Störung im Testserver schalten
    if [[ "$2" == on ]]; then touch "/srv/ctl/$1"; else rm -f "/srv/ctl/$1"; fi
    result "ctl=$1:$2"
    ;;

  sizes) # <name> — Plattenbedarf des Programmordners
    a="$(du -sm --exclude=eos --exclude=eos-venv --exclude=forecast-venv --exclude=bin --exclude=ml-models /opt/dvhub 2>/dev/null | cut -f1)"
    g="$(du -sm /opt/dvhub/.git 2>/dev/null | cut -f1)"
    n="$(find /opt/dvhub -xdev \( -path /opt/dvhub/eos -o -path /opt/dvhub/eos-venv -o -path /opt/dvhub/forecast-venv -o -path /opt/dvhub/.legacy-git \) -prune -o -type f -print | wc -l)"
    rel="$(du -sm /opt/dvhub/releases 2>/dev/null | cut -f1)"; leg="$(du -sm /opt/dvhub/.legacy-git 2>/dev/null | cut -f1)"
    cur="$(du -sm "$(readlink -f /opt/dvhub/current 2>/dev/null || echo /nonexistent)" 2>/dev/null | cut -f1)"
    nm="$(du -sm /opt/dvhub/dvhub/node_modules 2>/dev/null | cut -f1)"
    result "sizes=$1 program_mb=$a git_mb=${g:-0} files=$n releases_mb=${rel:-0} current_release_mb=${cur:-0} legacy_mb=${leg:-0} node_modules_mb=${nm:-0}"
    ;;

  facts) # <name> — Momentaufnahme für das Protokoll
    {
      echo "== $1 $(date -u)"
      ls -la /opt/dvhub
      ls -la /opt/dvhub/releases 2>/dev/null
      grep -E '^(WorkingDirectory|ExecStart|ExecStartPre)=' /etc/systemd/system/dvhub.service
      grep -c dvhub-release /etc/sudoers.d/dvhub-service-actions 2>/dev/null
      cat /var/lib/dvhub-release/state.json 2>/dev/null
      health; echo
    } >> "$OUT/facts.log" 2>&1
    result "facts=$1"
    ;;

  collect)
    journalctl -u dvhub --no-pager > "$OUT/journal-dvhub.log" 2>&1
    journalctl --no-pager -u 'dvhub-release*' > "$OUT/journal-release.log" 2>&1
    cp /var/lib/dvhub-release/job.log /var/lib/dvhub-release/status.json /var/lib/dvhub-release/state.json "$OUT/" 2>/dev/null
    cp /etc/systemd/system/dvhub.service "$OUT/dvhub.service" 2>/dev/null
    result "collect=ok"
    ;;

  *) echo "unbekannter Schritt: $step" >&2; exit 2 ;;
esac
