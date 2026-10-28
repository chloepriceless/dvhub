#!/usr/bin/env bash
# run-box.sh — ein Durchlauf der Versions-Matrix (docs/release-pakete.md):
# Box mit <tag> wie beim Kunden installieren, über die alte Oberfläche per git
# auf die Brückenversion (Test-v1.0.9 = aktueller Stand + Paketunterstützung)
# aktualisieren, automatische Umstellung auf das Paket abwarten, weiteres
# Paket-Update und Rückweg über die neue Oberfläche, optional Negativfälle.
#
#   run-box.sh <tag> <stable|dev> <out-dir> [--negative] [--platform linux/arm/v7] [--image IMG]
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R="${R:-$HOME/Projects/release-tests}"
TAG="$1"; CH="$2"; OUT="$3"; shift 3
NEG=0; PLATFORM=""; IMAGE="dvhub-boxsim:bookworm-2"; ARCH=arm64
while [[ $# -gt 0 ]]; do
  case "$1" in
    --negative) NEG=1; shift ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --arch) ARCH="$2"; shift 2 ;;
    *) echo "unbekannt: $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$OUT"
: > "$OUT/results.txt"
NAME="dvbox-$(echo "$TAG-$CH" | tr '.' '-')-$$"
SHA_A="$(cat "$R/sha-A")"; SHA_B="$(cat "$R/sha-B")"
dev_ver() { basename "$(ls -d "$R/build/"*"-dev."*".${1:0:8}")"; }
if [[ "$CH" == stable ]]; then V1=1.0.9; V2=1.0.10; else V1="$(dev_ver "$SHA_A")"; V2="$(dev_ver "$SHA_B")"; fi

T0=$(date +%s)
docker run -d --name "$NAME" ${PLATFORM:+--platform "$PLATFORM"} --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  -v "$R/mirror.git:/mnt/mirror:ro" -v "$R:/mnt/rt:ro" -v "$R/harness:/mnt/harness:ro" -v "$OUT:/mnt/out" \
  "$IMAGE" > "$OUT/container.id" || { echo "RESULT docker=failed" >> "$OUT/results.txt"; exit 1; }
for _ in $(seq 1 60); do
  s="$(docker exec "$NAME" systemctl is-system-running 2>/dev/null)"
  [[ "$s" == running || "$s" == degraded ]] && break
  sleep 1
done

S() { docker exec "$NAME" bash /mnt/harness/box-steps.sh "$@" 2>&1 | tee -a "$OUT/steps.log" | grep '^RESULT' ; }
echo "== $TAG $CH ($NAME) → $V1 → $V2"
S setup "$TAG"
S install "$TAG" "$CH"
S wait-health "" 300
S seed
S sizes "git-$TAG"
S check installed
S facts installed
S publish pub-1 v1.0.9
echo "RESULT git_update_mode=${GIT_UPDATE_MODE:-gui}" >> "$OUT/results.txt"
if [[ "${GIT_UPDATE_MODE:-gui}" == installer ]]; then
  # Unter Emulation (armv7/QEMU) reißt npm die 60-s-Grenze der alten
  # Oberfläche — dort der dokumentierte Weg über den Installer.
  S install v1.0.9 "$CH"
else
  S gui-git-update
fi
if [[ "$TAG" == v0.4.* && "${GIT_UPDATE_MODE:-gui}" != installer ]]; then
  # v0.4.x: Die alte Oberfläche holt v1.0.9 per git, ruft aber kein
  # post-update.sh als root auf (Unit ohne ExecStartPre, keine sudo-Regel),
  # und der neue Stand startet ohne apiToken nicht (Altbestand, nicht Teil
  # der Pakete). Handgriff wie beim Sprung 0.4 → 1.0: Installer erneut.
  S wait-health 1.0.9 60
  S install v1.0.9 "$CH"
fi
S wait-health 1.0.9 300
S sizes git-1.0.9
S reseed-state
S check after-git-update
S facts after-git-update
S wait-job migrate 900 migrate
S wait-health "$V1" 300
S sizes package
S check after-migration
S facts after-migration
S pub pub-2
S gui-check
S gui-pkg-update
S wait-job install 900 package-update
S wait-health "$V2" 120
S check after-package-update
S gui-rollback
S wait-job rollback 600 rollback
S wait-health "$V1" 120
S check after-rollback
S sizes package-after-update
S facts after-rollback

if [[ "$NEG" -eq 1 && "$CH" == stable ]]; then
  A="dvhub-1.0.10-$ARCH.tar.gz"
  echo "-- Negativ: verändertes Paket"
  S ctl "corrupt-$A" on; S gui-pkg-update; S wait-job install 600 neg-tampered; S ctl "corrupt-$A" off
  S wait-health 1.0.9 60; S check neg-tampered
  echo "-- Negativ: fremde Signatur"
  S pub pub-badsig; S gui-pkg-update; S wait-job install 600 neg-badsig; S pub pub-2
  S wait-health 1.0.9 60; S check neg-badsig
  echo "-- Negativ: Download bricht einmal ab (setzt fort)"
  S ctl "interrupt-once-$A" on; S gui-pkg-update; S wait-job install 900 neg-interrupt-once
  S wait-health 1.0.10 120; S check neg-interrupt-once
  echo "-- Negativ: Download bricht immer ab"
  S pub pub-3; S ctl "interrupt-always-dvhub-1.0.11-$ARCH.tar.gz" on; S gui-pkg-update; S wait-job install 900 neg-interrupt-always
  S ctl "interrupt-always-dvhub-1.0.11-$ARCH.tar.gz" off
  S wait-health 1.0.10 60; S check neg-interrupt-always
  echo "-- Negativ: Vorabprüfung Platz (Staging 8 MB)"
  docker exec "$NAME" bash -c 'mkdir -p /var/lib/dvhub-release/staging && mount -t tmpfs -o size=8m tmpfs /var/lib/dvhub-release/staging'
  S gui-pkg-update; S wait-job install 300 neg-precheck
  docker exec "$NAME" umount /var/lib/dvhub-release/staging
  S wait-health 1.0.10 60; S check neg-precheck
  echo "-- Negativ: Platte läuft während des Downloads voll (ENOSPC)"
  # tmpfs knapp über der Vorabprüfung (Paket + 16 MB + 4 MB), langsamer Download;
  # sobald er beginnt, füllt dd das Staging bis ENOSPC und gibt 1 MB zurück.
  SZ="$(node -e 'const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const r=i.releases.find(x=>x.version===i.latest);console.log(Math.ceil(r.artifacts[process.argv[2]].size/1048576)+20)' "$R/pub-3/channels/index-stable.json" "$ARCH")"
  docker exec "$NAME" bash -c "mount -t tmpfs -o size=${SZ}m tmpfs /var/lib/dvhub-release/staging"
  S ctl "slow-dvhub-1.0.11-$ARCH.tar.gz" on; S fill-staging 1; S gui-pkg-update; S wait-job install 300 neg-enospc
  S fill-report; S ctl "slow-dvhub-1.0.11-$ARCH.tar.gz" off
  docker exec "$NAME" bash -c 'ls -la /var/lib/dvhub-release/staging; umount /var/lib/dvhub-release/staging' >> "$OUT/steps.log" 2>&1
  S wait-health 1.0.10 60; S check neg-enospc
  echo "-- Negativ: neue Version startet nicht → automatischer Rückweg"
  S gui-pkg-update; S wait-job install 900 neg-health
  S wait-health 1.0.10 120; S check neg-health
  S facts after-negative
fi

S collect
echo "RESULT total_s=$(( $(date +%s) - T0 ))" >> "$OUT/results.txt"
docker rm -f "$NAME" >/dev/null
