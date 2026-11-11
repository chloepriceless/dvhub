#!/usr/bin/env bash
# scripts/eos-image-plan.sh — welches EOS-Image gehört zum Pin, und muss die CI
# es bauen?
#
# Seit 1.0.10 bindet DVhub das DVhub-EOS ein (Fork chloepriceless/EOS:
# Akkudoktor-EOS main + offene PRs, Git-Tag dvhub-eos-<version>-dvhub.<N>).
# Dafür baut unsere CI bikinibottomcapital/dvhub-eos:<version>-dvhub.<N> (Git-Tag
# ohne Präfix — Docker-Tags dürfen kein „+“ enthalten) aus dem unveränderten
# Dockerfile am Git-Tag, für amd64 und arm64. Ein offizielles Image gibt es dazu
# nie. Zeigt der Pin wieder auf ein Akkudoktor-Release mit offiziellem Image
# (docker.io/akkudoktor/eos:<Version>), wird genau das gezogen und hier nichts
# gebaut; für Vorab-Stände (v…rc…) baut die CI wie bisher dvhub-eos:<EOS_TAG>.
#
# Quelle ist docker/.env.example:
#   EOS_REPO, EOS_TAG   Git-Stand (immer; auch die native Installation)
#   EOS_IMAGE           leer = unser Image; docker.io/akkudoktor/eos = offiziell
#   EOS_IMAGE_TAG       Image-Tag; leer = Git-Tag (ohne „dvhub-eos-“).
#                       Unser Image: muss genau das sein. Offiziell: ohne „v“.
#
# Aufruf:  eos-image-plan.sh [--release] [env-Datei]
#   ohne --release (main):  bauen nur, wenn unser Image zum Pin noch fehlt;
#                           gibt es ein offizielles, nur ein Hinweis.
#   --release:              unser Image immer bauen (:latest wandert mit);
#                           gibt es ein offizielles, Abbruch — ein Release soll
#                           dann darauf zeigen, nicht auf einen Eigenbau.
#
# Ergebnis nach $GITHUB_OUTPUT (sonst Standardausgabe):
#   tag, repo, image, image_tag, build=true|false
set -euo pipefail

OFFICIAL="docker.io/akkudoktor/eos"
OURS="docker.io/bikinibottomcapital/dvhub-eos"

release=0
if [ "${1:-}" = "--release" ]; then release=1; shift; fi
env_file="${1:-docker/.env.example}"

val() { { grep -E "^$1=" "$env_file" || true; } | tail -n 1 | cut -d= -f2-; }
# docker.io/ ist der Standard — beide Schreibweisen meinen dasselbe Image.
canon() { case "$1" in docker.io/*) echo "$1" ;; */*.*/*|*.*/*) echo "$1" ;; *) echo "docker.io/$1" ;; esac; }
# Für Tests ersetzbar (EOS_PLAN_INSPECT="…"); sonst fragt docker die Registry.
exists() { ${EOS_PLAN_INSPECT:-docker manifest inspect} "$1" >/dev/null 2>&1; }
fail() { echo "::error::$*"; exit 1; }

tag="$(val EOS_TAG)"
repo="$(val EOS_REPO)"
[ -n "$tag" ] && [ -n "$repo" ] || fail "EOS_TAG/EOS_REPO fehlen in $env_file"

image="$(val EOS_IMAGE)"
image="$(canon "${image:-$OURS}")"
image_tag="$(val EOS_IMAGE_TAG)"
# Unser Image trägt den Git-Tag, beim DVhub-EOS ohne Präfix.
ours_tag="${tag#dvhub-eos-}"
image_tag="${image_tag:-$ours_tag}"
official_tag="${tag#v}"
# Zu DVhub-EOS gibt es kein offizielles Image — nicht danach fragen.
dvhub_eos=0
[ "$ours_tag" != "$tag" ] && dvhub_eos=1
build=false

if [ "$image" = "$OFFICIAL" ]; then
  [ "$image_tag" = "$official_tag" ] \
    || fail "EOS_IMAGE_TAG=$image_tag passt nicht zum Pin $tag (erwartet $official_tag)"
  exists "$OFFICIAL:$image_tag" \
    || fail "Offizielles EOS-Image $OFFICIAL:$image_tag gibt es nicht"
  echo "EOS: offizielles Image $OFFICIAL:$image_tag — nichts zu bauen."
elif [ "$image" = "$OURS" ]; then
  [ "$image_tag" = "$ours_tag" ] \
    || fail "EOS_IMAGE_TAG=$image_tag passt nicht zum Pin $tag (unser Image trägt den Git-Tag, beim DVhub-EOS ohne „dvhub-eos-“: $ours_tag)"
  if [ "$dvhub_eos" = 0 ] && exists "$OFFICIAL:$official_tag"; then
    hint="Zu EOS $tag gibt es ein offizielles Image ($OFFICIAL:$official_tag). In docker/.env.example EOS_IMAGE=$OFFICIAL und EOS_IMAGE_TAG=$official_tag setzen (und die Vorgabe in docker/compose.yml), dann entfällt der Eigenbau."
    [ "$release" = 1 ] && fail "$hint"
    echo "::warning::$hint"
  fi
  if [ "$release" = 1 ]; then
    build=true
    echo "EOS: Release — $OURS:$image_tag wird aus $repo#$tag gebaut."
  elif exists "$OURS:$image_tag"; then
    echo "EOS: $OURS:$image_tag ist schon veröffentlicht."
  else
    build=true
    echo "EOS: $OURS:$image_tag fehlt — wird aus $repo#$tag gebaut."
  fi
else
  fail "EOS_IMAGE=$image ist weder $OFFICIAL noch $OURS"
fi

{
  echo "tag=$tag"
  echo "repo=$repo"
  echo "image=$image"
  echo "image_tag=$image_tag"
  echo "build=$build"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"
