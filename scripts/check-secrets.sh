#!/usr/bin/env bash
# scripts/check-secrets.sh — secret / credential push-gate for the public mirror.
#
# Scans tracked, PUBLIC-bound files for hardcoded secrets, private-key material,
# embedded credentials and internal network topology. Internal-only material
# (.planning, internal docs) is excluded from the secret scan because it never
# ships to public (filtered out via git-filter-repo); in --public mode the gate
# additionally asserts that none of it is tracked at all.
#
# Usage:
#   bash scripts/check-secrets.sh              # private/CI mode (secrets + topology)
#   bash scripts/check-secrets.sh --public     # + assert no internal docs tracked
#
# Exit: 0 = clean, 1 = findings (block the push). No real secret values are
# hardcoded here — keep this gate green before every push to the public mirror.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

SELF='scripts/check-secrets.sh'
FAILED=0

PUBLIC=0
[ "${1:-}" = "--public" ] && PUBLIC=1

# Paths that are internal-only (never public). Excluded from the secret scan;
# asserted absent in --public mode (Check 6).
INTERNAL_GLOBS=(
  '.planning/**' 'dvhub/.planning/**' 'live-screenshots/**'
  'docs/plans/**' 'docs/research/**' 'docs/superpowers/**' 'docs/design-mockups/**'
  'dvhub/docs/superpowers/**' 'dvhub/docs/SESSION-NOTES-*.md' 'dvhub/docs/api-dvhub-de-*.md'
)
EXCL=( ":(exclude)$SELF" ":(exclude)**/node_modules/**" )
for g in "${INTERNAL_GLOBS[@]}"; do EXCL+=( ":(exclude)$g" ); done

scan() { # scan <label> <regex> [exclude-line-regex]
  local label="$1" rx="$2" filt="${3:-}" hits
  hits=$(git grep -nIE "$rx" -- . "${EXCL[@]}" 2>/dev/null || true)
  [ -n "$filt" ] && hits=$(printf '%s\n' "$hits" | grep -vE "$filt" || true)
  if [ -n "$hits" ]; then
    echo "✗ ${label}:"; printf '%s\n' "$hits" | sed 's/^/    /'; FAILED=1
  fi
}

echo "== DVhub Secret / Credential Push-Gate ($([ "$PUBLIC" = 1 ] && echo public || echo private)) =="

# 1) API tokens & cloud provider keys
scan "API-Token / Cloud-Keys" \
  '(ghp_|gho_|ghs_|ghu_|ghr_|github_pat_)[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[0-9A-Za-z-]{10}|sk_live_[0-9A-Za-z]{16}|glpat-[0-9A-Za-z_-]{20}|uk1_[0-9A-Za-z_-]{20}'

# 2) Private-key material (test fixtures with placeholder bodies are allowed)
scan "Private-Key-Material" \
  '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----' \
  '/test/|\.test\.js|fixtures?/'

# 3) Credentials embedded in URLs (localhost CI + obvious placeholders allowed)
scan "URL-Credentials" \
  '[a-zA-Z][a-zA-Z0-9+.-]*://[^/[:space:]:@"]+:[^/[:space:]@"]+@' \
  'localhost|127\.0\.0\.1|user:pass|USER:PASS|example|x\.x|<[A-Za-z]|\$\{|secret@host|/test/|\.test\.js|\.spec\.'

# 4) Hardcoded password / secret assignments
scan "Hartkodierte Credentials" \
  '(password|passwd|client_secret|api_?key|access_?token)["'"'"' ]{0,3}[:=]["'"'"' ]{1,3}[A-Za-z0-9/+_-]{8,}' \
  'process\.env|cfg\.|config\.|\.\.\.|placeholder|example|null|undefined|REDACT|\$\{|getCfg|hersteller|/test/|\.test\.js|\.spec\.'

# 5) Internal network topology — must be the generic 192.168.1.x placeholder
scan "Interne IP-Range (Topologie 192.168.1.x)" '192\.168\.20\.[0-9]+'

# 6) (public mode) internal planning / dev docs must not be tracked at all
if [ "$PUBLIC" = 1 ]; then
  INTERNAL=$(git ls-files "${INTERNAL_GLOBS[@]}" 2>/dev/null || true)
  if [ -n "$INTERNAL" ]; then
    echo "✗ Interne Planungs-/Dev-Dokumente getrackt (gehören nicht ins public Repo):"
    printf '%s\n' "$INTERNAL" | sed 's/^/    /'; FAILED=1
  fi
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ Sauber — keine Secrets / Credentials / interne Topologie gefunden."; exit 0
fi
echo "✗ Push-Gate FEHLGESCHLAGEN — Funde bereinigen (Code-Fix bzw. via filter-repo aus der Historie)."
exit 1
