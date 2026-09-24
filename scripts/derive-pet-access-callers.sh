#!/usr/bin/env bash
# Who calls the pet-access guards, and how many of them filter pets.deleted_at.
#
# WHY THIS IS A SCRIPT AND NOT A NUMBER IN A COMMENT
# ---------------------------------------------------------------------------
# The `resolvePetHolderAccess` docblock used to carry these figures inline,
# labelled "derived from the tree rather than estimated". They were wrong —
# 60/34 where the answer is 54/29 — because the sweep counted guard names that
# appear inside docblocks as if they were call sites, and counted this file's
# own internal composition as an independent consumer. The substantive claim
# survived (zero files guarded), but a number that says "measured" and does not
# reproduce is worse than no number, because the next unit scopes from it.
#
# So the command lives here and the docblock points at it. Re-run it; do not
# trust a transcription of its output.
#
# Run: bash scripts/derive-pet-access-callers.sh

set -euo pipefail
cd "$(dirname "$0")/.."

# Production sources only. Archived design docs under docs/superpowers/specs/
# contain `await requirePetAccess(` in markdown and are excluded by construction
# here, because this sweep only ever looks at .ts/.tsx.
ROOTS=(app lib src)

# One guard's independent consumers.
#   - awaited INVOCATIONS, so a name inside a docblock does not count;
#   - no tests: a test calling a guard is not a surface that needs one;
#   - no comment lines;
#   - not lib/infra/pet-access.ts itself, where requireAlivePetAccess and
#     requireTitularAccess each await requirePetAccess — internal composition,
#     not a consumer. Those two lines are the whole difference between 23 and 21.
sites() {
  grep -rn --include='*.ts' --include='*.tsx' "await $1(" "${ROOTS[@]}" 2>/dev/null \
    | grep -v '/__tests__/' \
    | grep -v '\.test\.' \
    | grep -vE ':[[:space:]]*(//|\*|/\*)' \
    | grep -v '^lib/infra/pet-access.ts:' \
    || true
}

# resolvePetHolderAccess is called with `await` in some places and wrapped in
# withDbBudgetOrThrow(...) in others, so it is matched on the bare invocation.
direct() {
  grep -rn --include='*.ts' --include='*.tsx' 'resolvePetHolderAccess(' "${ROOTS[@]}" 2>/dev/null \
    | grep -v '/__tests__/' \
    | grep -v '\.test\.' \
    | grep -vE ':[[:space:]]*(//|\*|/\*)' \
    | grep -v 'export async function resolvePetHolderAccess' \
    | grep -v '^lib/infra/pet-access.ts:' \
    || true
}

echo "== direct consumers of resolvePetHolderAccess =="
direct | cut -d: -f1 | sort | uniq -c | sort -rn
DIRECT_N=$(direct | wc -l | tr -d ' ')
# NUL-delimited, and `|| true` on the grep: filenames here contain `[publicToken]`,
# and `grep -l` exits non-zero when NOTHING matches — which is the expected
# answer, and under `set -e` would abort the script instead of printing a zero.
DIRECT_GUARDED=$(direct | cut -d: -f1 | sort -u | tr '\n' '\0' \
  | { xargs -0 -r grep -l -E 'pets\.deletedAt|pets\.deleted_at' 2>/dev/null || true; } \
  | wc -l | tr -d ' ')
echo "direct consumers: $DIRECT_N"
echo "  ...in files that mention pets.deleted_at: $DIRECT_GUARDED"

echo
echo "== consumers of the three composed web guards =="
TOTAL=0
for g in requirePetAccess requireAlivePetAccess requireTitularAccess; do
  n=$(sites "$g" | wc -l | tr -d ' ')
  echo "  $g: $n"
  TOTAL=$((TOTAL + n))
done
{ sites requirePetAccess; sites requireAlivePetAccess; sites requireTitularAccess; } \
  | cut -d: -f1 | sort -u > /tmp/dim-guard-files.txt
FILES=$(wc -l < /tmp/dim-guard-files.txt | tr -d ' ')
GUARDED=$(tr '\n' '\0' < /tmp/dim-guard-files.txt \
  | { xargs -0 -r grep -l -E 'pets\.deletedAt|pets\.deleted_at' 2>/dev/null || true; } \
  | wc -l | tr -d ' ')
echo "  total: $TOTAL across $FILES file(s)"
echo "  ...of those files, mentioning pets.deleted_at: $GUARDED"

echo
# The filter landed 2026-08-28: resolvePetHolderAccess carries
# isNull(pets.deletedAt) on both paths, so this figure is the number of call
# sites the choke-point fix covers, not a pending blast radius.
echo "== call sites covered by isNull(pets.deletedAt) inside resolvePetHolderAccess =="
echo "  $((DIRECT_N + TOTAL)) call site(s)"
