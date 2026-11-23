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
# Time limits. Every command that can wait on the network or on dpkg runs through `bounded`: in a process group of its
# own (setsid), and when its limit passes the WHOLE group gets TERM, then KILL $KILL_AFTER s later. That is why the
# part after the chromium download runs as root (re-run under sudo once, below): as root, install-deps runs apt with
# a plain `sh`, inside that group. Run as a user, it starts apt through sudo, and sudo (use_pty, the Ubuntu default)
# puts the command in a session of its own that no signal to our group reaches: on CI 45180359317 a timed-out
# apt-get survived the old `timeout` holding /var/lib/dpkg/lock-frontend, and the second try failed on the lock.
# Before dpkg, before each mirror try and before each `dpkg --configure -a`, the dpkg and apt locks must be free:
# wait_locks waits LOCK_WAIT (20) s, then KILLS any process still holding one (TERM, then KILL) - a holder that no
# group kill reached, in a session of its own as sudo starts one (CI 45181201761) - and waits again; still held, the
# step fails naming the holders. Killing a lock holder is acceptable only because the runner is ephemeral (nothing
# else on it uses apt, and it is discarded after the job) AND because the kill is followed at once by a bounded
# `dpkg --configure -a`: a dpkg or apt killed mid-run leaves dpkg "interrupted", and apt refuses to install until
# that repair has run. dpkg itself does not honour DPkg::Lock::Timeout, which is why the repair waits for the locks
# too; apt is told to wait at most LOCK_WAIT s for a lock rather than failing at once or waiting forever.
#
# Worst case by design, every limit reached (each bounded command can add KILL_AFTER; a lock scan is a few `find`s
# over /proc, well under a second, and the waits are deadlines, so a scan adds at most its own length to a wait):
#   wait_locks at most 20 + 10 + 20 + (30+10 repair) = 90 s, called at most 5 times (cache, and per try before the
#   try and before its repair) = 450
#   + 300+10 (chromium) + 2 x (60+10) (check before and after the cache) + 60+10 (dpkg -i) + 30+10 (apt-get -f)
#   + 2 tries x (60+10 update + 300+10 install-deps + 60+10 check + 30+10 dpkg --configure + PAUSE 10) = 1560
#   = 2010 s, 33.5 minutes: under the step's 35-minute limit and the job's 45.
set -u
DEBS_DIR="${DEBS_DIR:-$HOME/playwright-debs}"
APT_CONF="${APT_CONF:-/etc/apt/apt.conf.d/99ci-apt}"
APT_ARCHIVES="${APT_ARCHIVES:-/var/cache/apt/archives}"
LOCKS="${LOCKS:-/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock}"
PAUSE="${PAUSE:-10}" KILL_AFTER="${KILL_AFTER:-10}" LOCK_WAIT="${LOCK_WAIT:-20}"
T_CHROMIUM="${T_CHROMIUM:-300}" T_CHECK="${T_CHECK:-60}" T_DPKG="${T_DPKG:-60}" T_FIX="${T_FIX:-30}"
T_UPDATE="${T_UPDATE:-60}" T_INSTALL="${T_INSTALL:-300}" T_CONFIGURE="${T_CONFIGURE:-30}"
export DEBS_DIR APT_CONF APT_ARCHIVES LOCKS PAUSE KILL_AFTER LOCK_WAIT T_CHROMIUM T_CHECK T_DPKG T_FIX T_UPDATE T_INSTALL T_CONFIGURE

now_ms() { local t=${EPOCHREALTIME/./}; echo $(( 10#$t / 1000 )); }   # wall clock in ms (bash 5)

# bounded SECS CMD...: run CMD in a process group of its own; past SECS, TERM the whole group, KILL it KILL_AFTER s
# later. Returns CMD's status, or 124 when it was stopped.
bounded() {
  local secs=$1 pid deadline; shift
  deadline=$(( $(now_ms) + secs * 1000 ))   # wall clock, not loop turns: a loaded machine must not stretch the limit
  setsid "$@" & pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(now_ms)" -ge "$deadline" ]; then
      echo "OS packages: '$*' passed its ${secs} s limit: stopping its whole process group"
      kill -TERM -- "-$pid" 2>/dev/null
      local grace=$(( $(now_ms) + KILL_AFTER * 1000 ))
      while kill -0 -- "-$pid" 2>/dev/null && [ "$(now_ms)" -lt "$grace" ]; do sleep 0.1; done
      kill -KILL -- "-$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 0.1
  done
  wait "$pid"
}

# the processes holding any of $LOCKS open, as "pid (command)"
lock_holders() {
  local lock fd pid
  for lock in $LOCKS; do
    find /proc/[0-9]*/fd -lname "$lock" 2>/dev/null
  done | while read -r fd; do
    pid=${fd#/proc/}; pid=${pid%%/*}
    echo "$pid ($(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-60))"
  done | sort -u
}
# The dpkg/apt locks must be free before dpkg or apt runs. Wait for them (LOCK_WAIT s); a holder still there is one
# that no group kill reached (a process in a session of its own, as sudo starts one), so stop it: TERM, then KILL
# KILL_AFTER s later, and wait again. Locks that are still held after that fail the step, naming the holders.
wait_locks() {
  local h deadline round
  for round in wait stop; do
    deadline=$(( $(now_ms) + LOCK_WAIT * 1000 ))
    while :; do
      h=$(lock_holders)
      if [ -z "$h" ]; then
        # after a kill, the repair a killed dpkg or apt needs, before anything else uses dpkg
        if [ "$round" = stop ]; then echo "OS packages: repairing after the stopped holders: dpkg --configure -a"; bounded "$T_CONFIGURE" dpkg --configure -a || true; fi
        return 0
      fi
      [ "$(now_ms)" -ge "$deadline" ] && break
      sleep 0.2
    done
    [ "$round" = stop ] && break
    echo "OS packages: the dpkg/apt locks are still held after ${LOCK_WAIT} s, by: $(echo "$h" | tr '\n' ';') - stopping them"
    kill -TERM $(echo "$h" | cut -d' ' -f1) 2>/dev/null   # the pids: each line is "pid (command)"
    sleep "$KILL_AFTER"
    h=$(lock_holders); [ -n "$h" ] && kill -KILL $(echo "$h" | cut -d' ' -f1) 2>/dev/null
  done
  echo "OS packages: the dpkg/apt locks were still held after stopping their holders, by: $(echo "$h" | tr '\n' ';')"
  echo "OS packages: could not be installed; the browser check did not run"
  exit 1
}

# the dry-run check; its output (the missing packages, two spaces in) goes to file $1; status 0 = nothing missing
check() { bounded "$T_CHECK" npx playwright install-deps --dry-run chromium > "$1" 2>&1; local s=$?; cat "$1"; return $s; }
missing() { sed -n 's/^  \([a-z0-9][a-z0-9.+-]*\)$/\1/p' "$1"; }

if [ "${INSTALL_DEPS_AS_ROOT:-}" != 1 ]; then
  # as the runner's user: the browser itself, into the user's own cache
  bounded "$T_CHROMIUM" npx playwright install chromium || { echo "OS packages: the chromium download failed or timed out"; exit 1; }
  if [ "$(id -u)" != 0 ]; then
    exec sudo -E env "PATH=$PATH" HOME=/root INSTALL_DEPS_AS_ROOT=1 bash "$0" "$@"
  fi
fi

out=$(mktemp)
if check "$out"; then echo "OS packages: all present, nothing to install"; exit 0; fi
need=$(missing "$out")

# apt's limits first, for every apt command below
printf '%s\n' 'APT::Keep-Downloaded-Packages "true";' 'Binary::apt::APT::Keep-Downloaded-Packages "true";' \
  'Acquire::http::Timeout "30";' 'Acquire::https::Timeout "30";' 'Acquire::Retries "3";' \
  "DPkg::Lock::Timeout \"$LOCK_WAIT\";" > "$APT_CONF"

# 2. from the cache: only the missing packages' files
debs=()
for p in $need; do for f in "$DEBS_DIR/${p}"_*.deb; do [ -e "$f" ] && debs+=("$f"); done; done
if [ -n "$need" ] && [ "${#debs[@]}" -gt 0 ]; then
  wait_locks
  if bounded "$T_DPKG" dpkg -i "${debs[@]}" && check "$out"; then
    echo "OS packages: installed from the cache (${#debs[@]} .deb files)"; exit 0
  fi
  echo "OS packages: the cache did not cover them; installing from the mirror"
  bounded "$T_FIX" apt-get install -f -y || true   # repair whatever dpkg left half-installed
fi

# 3. from the mirror
for try in 1 2; do
  wait_locks
  if bounded "$T_UPDATE" apt-get update && bounded "$T_INSTALL" npx playwright install-deps chromium && check "$out"; then
    mkdir -p "$DEBS_DIR"
    kept=0
    for p in $need; do for f in "$APT_ARCHIVES/${p}"_*.deb; do [ -e "$f" ] && cp "$f" "$DEBS_DIR/" && kept=$((kept + 1)); done; done
    chmod -R a+rX "$DEBS_DIR" 2>/dev/null || true   # the cache step saves it as the runner's user
    echo "OS packages: installed from the mirror; $kept .deb files kept for the cache"
    exit 0
  fi
  echo "OS packages: try $try failed or timed out"
  wait_locks   # dpkg ignores DPkg::Lock::Timeout: run against a held lock, the repair would fail and try 2 with it
  bounded "$T_CONFIGURE" dpkg --configure -a || true; sleep "$PAUSE"
done
echo "OS packages: could not be installed in 2 tries (see above); the browser check did not run"
exit 1
