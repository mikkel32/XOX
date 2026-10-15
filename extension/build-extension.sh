#!/bin/sh
set -eu
node "$(dirname "$0")/build-extension.mjs" "$@"
