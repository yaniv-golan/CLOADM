# bb-only
# local-only: CLS with a colour past 0-8. On the original this prints ROM text (a hidden message), so the case is
# never written to a results file: node tools/basic-bb/run.js --rom ... --local --only screen-cls-range prints its
# shape (the lines typed, OK, blank lines and error codes as they are; any other line as <text N>, its length), which
# the maintainer reports by hand. The original's shape (bb2): 9-255 no error, one line of text, an empty line; 256
# and -1 ?FC ERROR. Ours prints its own line, MADE WITHOUT PEEKING (a deliberate difference: never the original's text).
CLS 9
CLS 10
CLS 255
CLS 256
CLS -1
PRINT "DONE"
