#!/bin/bash
# Run one browser-check group N times and record, per run: verdict, the target check's own diagnostic line, and
# the 1-minute load average BEFORE and AFTER the run (`before->after`: a run can straddle a change).
# Used to measure a browser-check group's failure rate (docs/development.md, "Measuring a check's failure rate").
# Needs Playwright resolvable by `node` (NODE_PATH pointing at a node_modules
# that has it, or an install it can find): it runs tools/browser-check.js, which requires('playwright').
#
#   ./flaky-n.sh <group> <N> <outfile> <needle>
#     group   a browser-check group name (audio, semantics)
#     N       how many runs
#     outfile where the per-run record goes
#     needle  substring of the check line to capture (its diagnostic names the bound that broke)
set -u
GROUP=$1; N=$2; OUT=$3; NEEDLE=$4
: > "$OUT"
# each run's log is its own file, so two measurements can run without colliding and nothing is left behind
TMPD=$(mktemp -d "${TMPDIR:-/tmp}/cloadm-flaky.XXXXXX") || exit 1
trap 'rm -rf "$TMPD"' EXIT
for i in $(seq 1 "$N"); do
  LOG="$TMPD/run-${i}.log"
  # the load BEFORE the run (what the run starts under) and after it (what it ended under): a run can straddle a
  # change, and one number at either end would hide that
  LOAD_BEFORE=$(uptime | sed -E 's/.*load averages?: *([0-9.]+).*/\1/')
  node tools/browser-check.js --only "$GROUP" > "$LOG" 2>&1
  RC=$?
  LOAD=$(uptime | sed -E 's/.*load averages?: *([0-9.]+).*/\1/')
  # the check's own line: `FAIL <name> <detail>` or `ok   <name> <detail>`
  LINE=$(grep -F "$NEEDLE" "$LOG" | grep -E '^(ok|FAIL)' | head -1)
  if [ -z "$LINE" ]; then LINE="(check line not found; group may have aborted)"; fi
  SUMMARY=$(grep -E '^groups: ' "$LOG" | tail -1)
  printf 'run %2d  rc=%s  load=%s->%s %s\n        %s\n' "$i" "$RC" "$LOAD_BEFORE" "$LOAD" "$SUMMARY" "$(echo "$LINE" | cut -c1-400)" >> "$OUT"
  # a failing run keeps its log (copied out of the temp dir); a passing one goes with it
  if [ "$RC" != "0" ] || echo "$LINE" | grep -q '^FAIL'; then
    KEPT="${OUT%.txt}-run-${i}.log"
    cp "$LOG" "$KEPT"
    echo "        kept: $KEPT" >> "$OUT"
  fi
done
echo "--- totals ---" >> "$OUT"
echo "runs: $N" >> "$OUT"
echo "failed: $(grep -c 'rc=[^0]' "$OUT")" >> "$OUT"
