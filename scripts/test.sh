#!/usr/bin/env bash
# Unified test entrypoint for humans, CI, and agents.
# One command to remember; wraps the canonical npm script.
set -euo pipefail
exec npm test -- "$@"
