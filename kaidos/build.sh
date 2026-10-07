#!/bin/sh
set -eu

VERSION=0.2.45
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

command -v node >/dev/null 2>&1 || { echo "Node.js is required" >&2; exit 1; }
command -v zip >/dev/null 2>&1 || { echo "zip is required" >&2; exit 1; }

node --check webapp/js/kados.js
node --check webapp/js/loader.js
node --check webapp/js/main.js
node test/run.js

rm -f "KaDOS-$VERSION.zip"
(cd webapp && zip -q -r -FS "../KaDOS-$VERSION.zip" .)
echo "KaDOS-$VERSION.zip готов (KaiOS explorer shell over JS x86 VM; не полноценный DOSBox/Fallout)"
