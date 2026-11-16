#!/bin/bash
# One family's 0.289 sweep, as the rows of docs/mame-0289-results.md. Prints one line per comparison.
#
#   bash tools/mame-diff/sweep-0289.sh <family>
#
# Run it through the project's heavy-job lock if you have one: these launch MAME and take a while. This
# script does not call that wrapper itself - nesting would wait on a lock it already holds.
#
# Families (the ones this script implements):
#   sam      lockstep for the nine SAM profiles
#   mc10     lockstep for mc10 and alice
#   coco3    lockstep for coco3 and coco3p
#   video    --video for a representative profile of each family
#   raster   --raster for the same
#   rate     --rate and --ops on dragon64 and coco
#   fdc      the four floppy controllers
#   alpha    the Dragon Alpha's own hardware (--board)
# Not covered here, run by hand: tape (tools/mame-diff/tape/run-tape.js) and the cartridges
# (run.js coco --cart <setup>). Their commands are in the results doc.
set -u
cd "$(dirname "$0")/../.." || exit 1
fam="${1:?usage: sweep-0289.sh <family>}"
[ $# -eq 1 ] || { echo "sweep-0289.sh: one family at a time (got: $*)" >&2; exit 2; }

run() { node tools/mame-diff/run.js "$@" 2>&1 | tail -1; }

case "$fam" in
  sam)  for p in dragon32 dragon64 dragon200 tanodr64 coco coco2b mx1600 lzcolor64 cd6809; do printf '| %s | ' "$p"; run "$p"; done ;;
  mc10) for p in mc10 alice; do printf '| %s | ' "$p"; run "$p"; done ;;
  coco3) for p in coco3 coco3p; do printf '| %s | ' "$p"; run "$p"; done ;;
  video) for p in dragon64 coco mc10 coco3; do printf '| %s | ' "$p"; run "$p" --video; done ;;
  raster) for p in dragon64 coco mc10 coco3; do printf '| %s | ' "$p"; run "$p" --raster; done ;;
  rate)
    for p in dragon64 coco; do
      printf '| %s rate | ' "$p"; run "$p" --rate
      printf '| %s ops | ' "$p"; run "$p" --ops
    done ;;
  fdc)
    printf '| dragon64 dragonfdc | '; run dragon64 --fdc
    printf '| dragon64 premierfdc | '; run dragon64 --fdc premierfdc
    printf '| coco cocofdc | '; run coco --fdc
    printf '| dgnalpha alphafdc | '; run dgnalpha --fdc alphafdc ;;
  alpha) printf '| dgnalpha board | '; run dgnalpha --board ;;
  *) echo "sweep-0289.sh: unknown family '$fam' (sam, mc10, coco3, video, raster, rate, fdc, alpha)" >&2; exit 2 ;;
esac
