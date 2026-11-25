# CLS with a colour past 8 (our own suite: on the original this prints ROM text, so the black-box case screen-cls-range
# is local-only). 9-255: our own line and an empty line, no error; a colour is truncated (9.5, 255.9); past 255, below
# 0 and 1E3 ?FC ERROR
CLS 9
CLS 9.5
CLS 255
CLS 255.9
CLS 256
CLS 1E3
CLS -1
