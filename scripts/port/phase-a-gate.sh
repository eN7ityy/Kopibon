#!/usr/bin/env bash
# Phase A gate (docs/rust-port/09-migration-phases.md §Phase A).
# Exit 0 iff all five machine-checkable exit conditions hold.
#
# Conditions whose work packages are not built yet report NOT-BUILT and fail
# the run — the gate "fails cleanly" from WP-A1 onward and passes only when
# Phase A is complete. It re-runs at every later phase (09 standing rules).
#
# Usage: bash scripts/port/phase-a-gate.sh [--fuzz N] [--skip-nightly-note]

set -u
cd "$(dirname "$0")/../.."

FAIL=0
declare -a SUMMARY

note() { SUMMARY+=("$1"); printf '%s\n' "$1"; }
fail() { FAIL=1; SUMMARY+=("FAIL: $1"); printf '%s\n' "FAIL: $1"; }

run_cargo_test() { # test-file label [extra args...]
  local testfile="$1" label="$2"; shift 2
  if [ ! -f "kopibon-core/tests/$testfile" ]; then
    note "NOT-BUILT [$label]: kopibon-core/tests/$testfile does not exist yet"
    FAIL=1
    return
  fi
  if cargo test -p kopibon-core --test "$testfile" "$@"; then
    note "PASS [$label]"
  else
    fail "$label"
  fi
}

command -v node >/dev/null || { fail "node not available (differential harness JS side)"; }
command -v python3 >/dev/null || { fail "python3 not available (zipfile CRC validator)"; }
[ -f tests/differential/harness.mjs ] || { note "NOT-BUILT [harness]: tests/differential/harness.mjs"; FAIL=1; }

# ── Exit 1: field × mutation matrix (12 write paths × 4 artefacts) ──────────
run_cargo_test differential_matrix "exit-1 differential_matrix (WR-01)"

# ── Exit 2: fuzz — 26/26 seeds + generated cases (≥10k per run) ─────────────
# The 1M nightly soak (template_fuzz --ignored, 1M) must have been clean three
# consecutive runs before the gate is FIRST declared (09 exit 2); this script
# runs the 10k CI-scale suite and reports the soak as an operator check.
FUZZ_N="${FUZZ_N:-10000}"
if [ -f kopibon-core/tests/template_fuzz.rs ]; then
  if FUZZ_CASES="$FUZZ_N" cargo test -p kopibon-core --test template_fuzz -- --ignored; then
    note "PASS [exit-2 template fuzz (TA-02, n=$FUZZ_N)]"
  else
    fail "exit-2 template fuzz (TA-02, n=$FUZZ_N)"
  fi
  # Operator check: the 1M nightly soak must have been clean three consecutive
  # runs before the gate is FIRST declared (09 exit 2). Re-run with:
  #   FUZZ_CASES=1000000 cargo test -p kopibon-core --test template_fuzz -- --ignored
else
  note "NOT-BUILT [exit-2]: kopibon-core/tests/template_fuzz.rs"
  FAIL=1
fi
if [ -f kopibon-core/tests/template_differential.rs ]; then
  run_cargo_test template_differential "exit-2 template seeds (TA-01)"
else
  note "NOT-BUILT [exit-2]: kopibon-core/tests/template_differential.rs"
  FAIL=1
fi

# ── Exit 3: scanner parity + removal triple guard ───────────────────────────
run_cargo_test scanner_differential "exit-3 scanner_differential (SC-01)"
run_cargo_test removal_guard "exit-3 removal_guard (SC-02)"

# ── Exit 4: DB parity ────────────────────────────────────────────────────────
run_cargo_test db_differential "exit-4 db_differential (DB-01/DB-02)"

# ── Exit 5: pumps (download/conversion/sync) incl. crash recovery ───────────
run_cargo_test download_differential "exit-5 download_differential (DL-01)"
run_cargo_test conversion "exit-5 conversion (CV-01)"
run_cargo_test sync_differential "exit-5 sync_differential (SY-01)"
run_cargo_test crash_recovery "exit-5 crash_recovery (CR-01)" -- --test-threads=1

printf '\n===== Phase A gate summary =====\n'
for line in "${SUMMARY[@]}"; do printf '%s\n' "$line"; done
if [ "$FAIL" -eq 0 ]; then
  echo "PHASE A GATE: PASS (all five exit conditions green)"
else
  echo "PHASE A GATE: FAIL (see NOT-BUILT/FAIL lines above)"
fi
exit "$FAIL"
