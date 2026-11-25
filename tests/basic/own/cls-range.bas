# CLS with a colour past 8 (our own suite: on the original this prints ROM text, so the black-box case screen-cls-range
# is local-only). 9-255: our own line and an empty line, no error; past 255 ?FC ERROR
CLS 9
CLS 255
CLS 256
CLS -1
