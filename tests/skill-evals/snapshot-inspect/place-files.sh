#!/usr/bin/env bash
set -eu
here="$(dirname "$0")"
if [ -d "$here/files" ]; then cp -R "$here/files/." .; fi
node "$here/setup.js" .
