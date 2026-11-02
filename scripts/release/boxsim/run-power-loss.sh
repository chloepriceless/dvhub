#!/usr/bin/env bash
# run-power-loss.sh — Stromausfall mitten in der Umstellung git → Paket, mit
# echtem systemd (docs/release-pakete.md). Box auf v1.0.8 installieren, per
# alter Oberfläche auf die Brücke 1.0.9 (git), automatische Umstellung
# zurückhalten, dann den Zwischenstand herstellen, den dvhub-release beim
# Verschieben hinterlässt (dvhub verschoben+verlinkt, post-update.sh verschoben
# ohne Verweis, Journal phase=moving, Notfall-Drop-in aktiv), Container neu
# starten (= Neustart der Box) und prüfen:
#   - recover läuft im Start VOR post-update.sh und stellt den git-Stand her
#   - post-update.sh läuft in demselben Start trotzdem
#   - DVhub ist gesund (git 1.0.9), Drop-in weg, Reload später nachgeholt
#   - eine anschließende Umstellung klappt
#   run-power-loss.sh <out-dir>
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R="${R:-$HOME/Projects/release-tests}"
OUT="$1"; mkdir -p "$OUT"; : > "$OUT/results.txt"
NAME="dvbox-powerloss-$$"
docker run -d --name "$NAME" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 -v "$R/mirror.git:/mnt/mirror:ro" -v "$R:/mnt/rt:ro" \
  -v "$R/harness:/mnt/harness:ro" -v "$OUT:/mnt/out" dvhub-boxsim:bookworm-2 > /dev/null
boot() { for _ in $(seq 1 60); do s="$(docker exec "$NAME" systemctl is-system-running 2>/dev/null)"; [[ "$s" == running || "$s" == degraded ]] && return; sleep 1; done; }
boot
S() { docker exec "$NAME" bash /mnt/harness/box-steps.sh "$@" 2>&1 | tee -a "$OUT/steps.log" | grep '^RESULT'; }
X() { docker exec "$NAME" bash -c "$1" 2>&1 | tee -a "$OUT/steps.log"; }
S setup v1.0.8
S install v1.0.8 stable
S wait-health "" 120
S seed
S publish pub-1 v1.0.9
X 'printf "base_url=http://127.0.0.1:8088\nmigrate_delay_s=86400\n" > /etc/dvhub-release/release.conf'
S gui-git-update
S wait-health 1.0.9 120
S reseed-state
X 'systemctl stop dvhub-release-migrate.timer 2>/dev/null; true'
echo "-- Zwischenstand wie beim Abbruch mitten im Verschieben"
X 'set -e
systemctl stop dvhub
cd /opt/dvhub
mkdir -p releases/1.0.9 && tar -xzf /mnt/rt/pub-1/v1.0.9/dvhub-1.0.9-arm64.tar.gz -C releases/1.0.9 --no-same-owner
ln -s releases/1.0.9 current
mkdir -p /var/lib/dvhub-release && cp /etc/systemd/system/dvhub.service /var/lib/dvhub-release/dvhub.service.git-backup
node -e "
  const H=require(\"/usr/local/libexec/dvhub-release\");const fs=require(\"fs\");const s=H.settings();
  fs.mkdirSync(s.dropinDir,{recursive:true});
  fs.writeFileSync(s.dropinDir+\"/05-dvhub-release-recover.conf\",H.dropinContent(s,fs.readFileSync(s.unitFile,\"utf8\")));
  fs.writeFileSync(\"/var/lib/dvhub-release/state.json\",JSON.stringify({format:1,migration:{phase:\"moving\",version:\"1.0.9\",legacy:\"/opt/dvhub/.legacy-git\",
    moved:[\"dvhub\"],linked:[\"dvhub\"],moving:\"post-update.sh\",unit_backup:\"/var/lib/dvhub-release/dvhub.service.git-backup\",boot_id:\"vor-dem-ausfall\"},migrate:{attempts:1,last_attempt:0}}));
"
systemctl daemon-reload
mkdir .legacy-git && mv dvhub .legacy-git/ && ln -s current/dvhub dvhub && mv post-update.sh .legacy-git/
cat /etc/systemd/system/dvhub.service.d/05-dvhub-release-recover.conf
systemctl show dvhub -p ExecStartPre --value | tr ";" "\n" | grep -o "path=[^ ]*"
sync'
echo "-- Stromausfall: Container neu starten"
T_RESTART="$(docker exec "$NAME" date -u '+%Y-%m-%d %H:%M:%S')"
docker restart "$NAME" > /dev/null
boot
S server
S wait-health 1.0.9 180
X 'echo "== Start-Reihenfolge"; journalctl --since "'"$T_RESTART"' UTC" -u dvhub --no-pager | grep -nE "recover|DVhub post-update|Post-Update abgeschlossen|Web server listening|vanished" | head -20
ls -la /opt/dvhub | grep -E " dvhub| post-update.sh| current|legacy"
test -d /opt/dvhub/dvhub -a ! -L /opt/dvhub/dvhub && echo "dvhub: Ordner (git)"; test -f /opt/dvhub/post-update.sh -a ! -L /opt/dvhub/post-update.sh && echo "post-update.sh: Datei (git)"
test -e /opt/dvhub/current || echo "current: weg"
git -c safe.directory=/opt/dvhub -C /opt/dvhub status --porcelain --untracked-files=no | head -5; echo "git status Ende"'
R1="$(docker exec "$NAME" bash -c "journalctl --since '$T_RESTART UTC' -u dvhub --no-pager | grep -n 'recover:' | head -1 | cut -d: -f1")"
R2="$(docker exec "$NAME" bash -c "journalctl --since '$T_RESTART UTC' -u dvhub --no-pager | grep -n 'DVhub post-update' | head -1 | cut -d: -f1")"
ok=0; [[ -n "${R1:-}" && -n "${R2:-}" && "$R1" -lt "$R2" ]] && ok=1
echo "RESULT order=$ok recover_line=${R1:-none} post_update_line=${R2:-none}" | tee -a "$OUT/results.txt"
sleep 40
X 'echo "== nach 40 s"; ls /etc/systemd/system/dvhub.service.d/; systemctl show dvhub -p DropInPaths --value; journalctl --no-pager -u dvhub-release-reload | tail -3; cat /var/lib/dvhub-release/state.json'
S check after-power-loss
echo "-- danach: normale Umstellung"
X 'printf "base_url=http://127.0.0.1:8088\nmigrate_delay_s=15\n" > /etc/dvhub-release/release.conf; /usr/local/libexec/dvhub-release migrate | tail -3'
S wait-health 1.0.9 120
S check after-migration
S facts after-migration
S collect
docker rm -f "$NAME" > /dev/null
