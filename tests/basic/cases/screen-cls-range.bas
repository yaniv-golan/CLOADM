# bb-only
# local-only: CLS with a colour past 0-8. On the original this prints ROM text (a hidden message), so the case is
# never written to a results file: node tools/basic-bb/run.js --rom ... --local --only screen-cls-range prints its
# shape (the lines typed, OK, blank lines and error codes as they are; any other line as <text N>, its length), which
# the maintainer reports by hand. Ours gives ?FC ERROR for now, until that shape is known; then ours prints a line of
# its own text in the same shape (a deliberate difference: never the original's message).
CLS 9
CLS 10
CLS 255
CLS 256
CLS -1
PRINT "DONE"
