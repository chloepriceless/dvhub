#!/usr/bin/env bash
# run-matrix.sh — alle Versionsstände der Release-Paket-Tests
# (docs/release-pakete.md). Vorher: prepare.sh. Ergebnisse unter
# $R/runs/<zeit>/ (je Fall ein Ordner + RESULTS.md).
#
#   run-matrix.sh [--jobs N] [fall …]     fall = <tag>:<kanal>[:neg]
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R="${R:-$HOME/Projects/release-tests}"
JOBS=3
CASES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --jobs) JOBS="$2"; shift 2 ;;
    *) CASES+=("$1"); shift ;;
  esac
done
if [[ ${#CASES[@]} -eq 0 ]]; then
  CASES=(v0.4.2:stable v1.0.0:stable v1.0.1:stable v1.0.2:stable v1.0.3:stable v1.0.4:stable
         v1.0.5:stable v1.0.6:stable v1.0.7:stable v1.0.8:stable:neg v1.0.0:dev v1.0.8:dev)
fi
RUN="$R/runs/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RUN"
echo "Matrix → $RUN"
run_case() {
  local tag ch neg
  IFS=: read -r tag ch neg <<< "$1"
  bash "$HERE/run-box.sh" "$tag" "$ch" "$RUN/$tag-$ch" ${neg:+--negative} > "$RUN/$tag-$ch.console.log" 2>&1
  echo "fertig: $tag $ch"
}
export -f run_case
export HERE RUN R
printf '%s\n' "${CASES[@]}" | xargs -P "$JOBS" -I{} bash -c 'run_case "$@"' _ {}
node "$HERE/summarize.mjs" "$RUN" > "$RUN/RESULTS.md"
cat "$RUN/RESULTS.md"
