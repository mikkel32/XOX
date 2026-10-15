#!/bin/zsh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cp "$root/bridgezone-tools.user.js" "$root/extension/bridgezone-main.js"
