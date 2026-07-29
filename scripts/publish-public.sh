#!/usr/bin/env bash
# publish-public.sh — den gefilterten Baum ins öffentliche Repo bringen.
#
# Christin, 29.07.2026: entwickelt wird ab jetzt ÖFFENTLICH. Nicht öffentlich
# sind nur die Planungsunterlagen und die Tests. Vorher war dieser Filter eine
# Anleitung in .planning/RESUME.md — also etwas, das man von Hand richtig machen
# musste. Jetzt steht er hier, und das Skript bricht ab, wenn doch ein
# gefilterter Pfad im Ergebnis landet.
#
#   scripts/publish-public.sh <ref> [--push]
#
# Ohne --push wird nur committet und der Push-Befehl ausgegeben — absichtlich,
# damit man den Diff vorher ansehen kann. `remote.public.pushurl` steht bewusst
# auf DISABLED, damit kein versehentliches `git push public` etwas Internes
# hinausträgt; der Push läuft deshalb über die ausdrückliche URL.

set -euo pipefail

REF="${1:-}"
PUSH="${2:-}"
if [[ -z "$REF" ]]; then
  echo "usage: $0 <ref> [--push]" >&2
  exit 64
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Was NICHT öffentlich wird ─────────────────────────────────────────────────
# Planungs-/Recherche-Unterlagen: interne Notizen, Kundennamen, Anlagen-IPs.
# Tests: Christins Entscheidung 29.07. — sie gehören zur Entwicklung, nicht auf
# eine Kundenbox. Nichts im Laufzeitpfad importiert sie (geprüft), und weder
# install.sh noch post-update.sh führen sie aus.
# .github/: die CI führt genau diese Tests aus und wäre ohne sie dauerhaft rot.
FILTERED_PATHS=(
  ".planning"
  "dvhub/.planning"
  "docs/plans"
  "docs/research"
  "docs/superpowers"
  "docs/design-mockups"
  "dvhub/docs/superpowers"
  "dvhub/docs/api-dvhub-de-EXTENSION-PROPOSAL.md"
  "dvhub/test"
  "tests"
  ".github"
)
FILTERED_GLOBS=(
  "dvhub/docs/SESSION-NOTES-*.md"
)

PUBLIC_URL="$(git config --get remote.public.url)"
if [[ -z "$PUBLIC_URL" ]]; then
  echo "FEHLER: remote.public.url ist nicht gesetzt." >&2
  exit 1
fi

STAGE="$(mktemp -d)"
WORKTREE="$REPO_ROOT/.public-publish"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

echo "→ Baum aus $REF entpacken"
git archive "$REF" | tar -x -C "$STAGE"

echo "→ interne Pfade entfernen"
for p in "${FILTERED_PATHS[@]}"; do
  if [[ -e "$STAGE/$p" ]]; then
    rm -rf "${STAGE:?}/$p"
    echo "   entfernt: $p"
  fi
done
for g in "${FILTERED_GLOBS[@]}"; do
  # shellcheck disable=SC2086
  for f in $STAGE/$g; do
    [[ -e "$f" ]] || continue
    rm -rf "$f"
    echo "   entfernt: ${f#"$STAGE"/}"
  done
done

echo "→ Kontrolle: nichts Gefiltertes übrig"
for p in "${FILTERED_PATHS[@]}"; do
  if [[ -e "$STAGE/$p" ]]; then
    echo "FEHLER: $p ist trotz Filter noch da — Abbruch." >&2
    exit 1
  fi
done

# Fangnetz gegen versehentlich mitgereiste Anlagen-Adressen aus dem LAN.
if grep -rIl --exclude-dir=node_modules -E '192\.168\.(20|30)\.[0-9]+' "$STAGE" >/dev/null 2>&1; then
  echo "WARNUNG: interne IP-Adressen im gefilterten Baum gefunden:" >&2
  grep -rIl --exclude-dir=node_modules -E '192\.168\.(20|30)\.[0-9]+' "$STAGE" | sed "s#$STAGE/##" >&2
  echo "         Prüfen und ggf. bereinigen, BEVOR gepusht wird." >&2
fi

echo "→ Worktree auf public/main vorbereiten"
git fetch public main --quiet
if [[ -d "$WORKTREE" ]]; then
  git worktree remove --force "$WORKTREE"
fi
git worktree add --quiet --detach "$WORKTREE" public/main

# rsync ist im Dev-Container nicht installiert — bewusst mit find/cp gelöst.
find "$WORKTREE" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a "$STAGE/." "$WORKTREE/"

cd "$WORKTREE"
git add -A
if git diff --cached --quiet; then
  echo "→ keine Änderungen gegenüber public/main — nichts zu tun."
  cd "$REPO_ROOT"
  git worktree remove --force "$WORKTREE"
  exit 0
fi

FILE_COUNT="$(git ls-files | wc -l | tr -d ' ')"
git commit --quiet -m "release: $REF"
NEW_REV="$(git rev-parse HEAD)"
cd "$REPO_ROOT"

echo
echo "Commit im Worktree: ${NEW_REV:0:8}  ($FILE_COUNT Dateien)"
echo "Diff ansehen:  git -C $WORKTREE show --stat HEAD"
echo

if [[ "$PUSH" == "--push" ]]; then
  echo "→ Push nach public/main"
  git -C "$WORKTREE" push "$PUBLIC_URL" "HEAD:main"
  echo "Fertig. Tag setzen nicht vergessen:"
  echo "  git -C $WORKTREE tag public-$REF $NEW_REV"
  echo "  git -C $WORKTREE push $PUBLIC_URL public-$REF:refs/tags/$REF"
else
  echo "NICHT gepusht (kein --push). Wenn der Diff stimmt:"
  echo "  git -C $WORKTREE push \"\$(git config --get remote.public.url)\" HEAD:main"
fi
