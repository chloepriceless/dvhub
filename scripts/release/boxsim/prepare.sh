#!/usr/bin/env bash
# prepare.sh — bereitet die Versions-Matrix der Release-Paket-Tests vor
# (docs/release-pakete.md, Abschnitt Tests). Alles unter $R (Vorgabe
# ~/Projects/release-tests), nichts wird veröffentlicht.
#
#   1. Wegwerf-Schlüssel (nie der echte Release-Schlüssel)
#   2. Test-Repo = aktueller Branch-Stand + Test-Releases:
#        A  v1.0.9   allowed_signers mit Testschlüssel, Version 1.0.9 (Brücke: erste Version mit Paketen)
#        B  v1.0.10  weiteres Update
#        C  v1.0.11  absichtlich kaputt (server.js beendet sich) → Rückweg-Test
#   3. Spiegel (bare) mit allen echten Tags v0.3.9…v1.0.8 und den Test-Tags
#   4. Pakete: stable 1.0.9/1.0.10/1.0.11, dev aus A und B (arm64, armhf)
#   5. Veröffentlichungsstände pub-1 (1.0.9 / dev A), pub-2 (+1.0.10 / dev B),
#      pub-3 (+1.0.11), pub-badsig (1.0.10 mit fremder Paketsignatur)
set -euo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_REPO="$(cd "$HERE/../../.." && pwd)"
R="${R:-$HOME/Projects/release-tests}"
ARCHS="${ARCHS:-arm64,armhf}"
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

mkdir -p "$R/keys"
[[ -f "$R/keys/test_ed25519" ]] || ssh-keygen -q -t ed25519 -N '' -C dvhub-release-TEST -f "$R/keys/test_ed25519"
[[ -f "$R/keys/wrong_ed25519" ]] || ssh-keygen -q -t ed25519 -N '' -C dvhub-release-WRONG -f "$R/keys/wrong_ed25519"
chmod 600 "$R/keys/"*_ed25519
KEY="$R/keys/test_ed25519"
TRUST_LINE="dvhub-release namespaces=\"dvhub-release,dvhub-release-index\" $(cat "$KEY.pub")"

echo "[1/5] Test-Repo"
rm -rf "$R/work"; mkdir -p "$R/work"
git clone -q --no-local "$SRC_REPO" "$R/work/repo"
W="$R/work/repo"
BRANCH_SHA="$(git -C "$SRC_REPO" rev-parse HEAD)"
git -C "$W" checkout -q -B main "$BRANCH_SHA"
git -C "$W" fetch -q --tags "$SRC_REPO"
export GIT_AUTHOR_NAME=release-test GIT_AUTHOR_EMAIL=test@localhost GIT_COMMITTER_NAME=release-test GIT_COMMITTER_EMAIL=test@localhost
bump() {  # <version> <datum>
  local v="$1" d="$2"
  node -e '
    const fs=require("fs");const [f,v]=process.argv.slice(1);
    for (const p of [f+"/dvhub/package.json"]) { const j=JSON.parse(fs.readFileSync(p,"utf8")); j.version=v; fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n"); }
    const l=f+"/dvhub/package-lock.json"; const j=JSON.parse(fs.readFileSync(l,"utf8")); j.version=v; if (j.packages&&j.packages[""]) j.packages[""].version=v; fs.writeFileSync(l, JSON.stringify(j,null,2)+"\n");
  ' "$W" "$v"
  V="$v" D="${d%%T*}" perl -0pi -e 's/^## \[Unreleased\]/## [Unreleased]\n\n## [$ENV{V}] - $ENV{D}\n\n- Test-Release $ENV{V} für die Paket-Matrix/m' "$W/CHANGELOG.md"
  git -C "$W" add -A
  GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" git -C "$W" commit -q -m "test(release): $v"
  git -C "$W" tag -f "v$v" >/dev/null
}
printf '%s\n' "$TRUST_LINE" >> "$W/release-keys/allowed_signers"
bump 1.0.9 2026-10-28T10:00:00Z
SHA_A="$(git -C "$W" rev-parse HEAD)"
bump 1.0.10 2026-10-29T10:00:00Z
SHA_B="$(git -C "$W" rev-parse HEAD)"
perl -0pi -e 's/\A/process.exit(3); \/\/ Test: kaputtes Release\n/' "$W/dvhub/server.js"
bump 1.0.11 2026-10-30T10:00:00Z
git -C "$W" checkout -q -B main "$SHA_A"
echo "    A=$SHA_A B=$SHA_B"

echo "[2/5] Spiegel"
rm -rf "$R/mirror.git"
git clone -q --mirror "$W" "$R/mirror.git"
# Ohne Remote-Referenzen des Spiegels selbst; main = A (wird je Box gesetzt).
git -C "$R/mirror.git" for-each-ref --format='%(refname)' refs/remotes | xargs -r -n1 git -C "$R/mirror.git" update-ref -d
git -C "$R/mirror.git" gc -q --prune=now
printf '%s\n' "$SHA_A" > "$R/sha-A"; printf '%s\n' "$SHA_B" > "$R/sha-B"

echo "[3/5] Pakete"
rm -rf "$R/build"
B="$HERE/../build-release.sh"
for ref in v1.0.9 v1.0.10 v1.0.11 "$SHA_A" "$SHA_B"; do
  bash "$B" "$ref" --repo "$W" --key "$KEY" --arch "$ARCHS" --out "$R/build" > "$R/build-$ref.log" 2>&1 || { tail -20 "$R/build-$ref.log"; exit 1; }
  grep -E 'arm64:|armhf:' "$R/build-$ref.log"
done

echo "[4/5] Veröffentlichungsstände"
P="$HERE/../publish-release.sh"
dev_dir() { ls -d "$R/build/"*"-dev."*".${1:0:8}"; }
rm -rf "$R/pub" "$R"/pub-*
pub() { bash "$P" "$1" --key "$KEY" --repo "$W" --dry-run --dest "$R/pub" >> "$R/publish.log" 2>&1; }
pub "$R/build/1.0.9"; pub "$(dev_dir "$SHA_A")"
cp -a "$R/pub" "$R/pub-1"
pub "$R/build/1.0.10"; pub "$(dev_dir "$SHA_B")"
cp -a "$R/pub" "$R/pub-2"
pub "$R/build/1.0.11"
cp -a "$R/pub" "$R/pub-3"
# Fremde Paketsignatur bei 1.0.10 (Index bleibt korrekt signiert).
cp -a "$R/pub-2" "$R/pub-badsig"
for f in "$R/pub-badsig/v1.0.10/"*.tar.gz; do
  rm -f "$f.sig"; ssh-keygen -Y sign -q -f "$R/keys/wrong_ed25519" -n dvhub-release "$f"
done

echo "[5/5] Prüfstand-Dateien"
mkdir -p "$R/harness"
cp "$HERE/testserver.mjs" "$HERE/box-steps.sh" "$R/harness/"
du -sh "$R/mirror.git" "$R/build"/* | sed 's/^/    /'
echo "fertig: $R"
