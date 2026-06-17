#!/usr/bin/env bash
# Unified local dev entrypoint. Runs the daemon from source via tsx.
set -euo pipefail
exec npm run dev -- "$@"
