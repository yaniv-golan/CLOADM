#!/usr/bin/env bash
# Installs Playwright's chromium and the OS packages it needs, for the CI browser-check jobs (tests.yml and
# browser-daily.yml run this one script). tests/install-browser-deps.test.js runs it with stub commands.
#
# Every decision is Playwright's own check: `npx playwright install-deps --dry-run chromium` simulates installing its
# exact package list (apt-get install -s) and exits 1 listing what is missing. The step ends successfully only after
# that check passes, so the browser check always runs with every package Playwright asks for, however they arrived.
#
#   1. Nothing missing: nothing to do.
#   2. A cache of the missing packages' .deb files (restored by actions/cache into $DEBS_DIR, keyed on the runner
#      image): dpkg -i of ONLY the cached files of packages the check reports missing, from disk (apt-get install of
#      the same files fetched them from the mirror again), then the check again. A package the image already has is
#      never touched, so nothing on the image is downgraded.
#   3. Otherwise the mirror, at most twice: apt-get update, then install-deps. The .deb files of the packages that
#      were missing (Playwright's list only, not whatever else apt upgraded) are kept in $DEBS_DIR for the cache.
#
# Time limits: every command that can wait on the network or on dpkg has its own `timeout` (which signals its whole
# process group), and apt drops a stalled connection after 30 s. Worst case by design, with every limit reached:
# 120 (chromium) + 2 x 60 (check before and after the cache) + 60 (dpkg) + 60 (apt-get -f)
# + 2 tries x (60 update + 300 install-deps + 60 check + 60 dpkg --configure + PAUSE 10) = 1340 s, about 22.3 minutes:
# under the step's 25-minute limit and the job's 30.
set -u
DEBS_DIR="${DEBS_DIR:-$HOME/playwright-debs}"
APT_CONF="${APT_CONF:-/etc/apt/apt.conf.d/99ci-apt}"
APT_ARCHIVES="${APT_ARCHIVES:-/var/cache/apt/archives}"
PAUSE="${PAUSE:-10}"

# the missing packages, one per line, from a dry-run's output; exit status 0 = nothing missing
check() { timeout 60 npx playwright install-deps --dry-run chromium > "$1" 2>&1; local s=$?; cat "$1"; return $s; }
missing() { sed -n 's/^  \([a-z0-9][a-z0-9.+-]*\)$/\1/p' "$1"; }

out=$(mktemp)
timeout 120 npx playwright install chromium || { echo "OS packages: the chromium download failed or timed out"; exit 1; }
if check "$out"; then echo "OS packages: all present, nothing to install"; exit 0; fi
need=$(missing "$out")

# apt's limits first, for every apt command below
printf '%s\n' 'APT::Keep-Downloaded-Packages "true";' 'Binary::apt::APT::Keep-Downloaded-Packages "true";' \
  'Acquire::http::Timeout "30";' 'Acquire::https::Timeout "30";' 'Acquire::Retries "3";' \
  | sudo tee "$APT_CONF" >/dev/null

# 2. from the cache: only the missing packages' files
debs=()
for p in $need; do for f in "$DEBS_DIR/${p}"_*.deb; do [ -e "$f" ] && debs+=("$f"); done; done
if [ -n "$need" ] && [ "${#debs[@]}" -gt 0 ]; then
  if timeout 60 sudo dpkg -i "${debs[@]}" && check "$out"; then
    echo "OS packages: installed from the cache (${#debs[@]} .deb files)"; exit 0
  fi
  echo "OS packages: the cache did not cover them; installing from the mirror"
  timeout 60 sudo apt-get install -f -y || true   # repair whatever dpkg left half-installed
fi

# 3. from the mirror
for try in 1 2; do
  if timeout 60 sudo apt-get update && timeout 300 npx playwright install-deps chromium && check "$out"; then
    mkdir -p "$DEBS_DIR"
    kept=0
    for p in $need; do for f in "$APT_ARCHIVES/${p}"_*.deb; do [ -e "$f" ] && cp "$f" "$DEBS_DIR/" && kept=$((kept + 1)); done; done
    echo "OS packages: installed from the mirror; $kept .deb files kept for the cache"
    exit 0
  fi
  echo "OS packages: try $try failed or timed out"; timeout 60 sudo dpkg --configure -a || true; sleep "$PAUSE"
done
echo "OS packages: could not be installed in 2 tries (see above); the browser check did not run"
exit 1
