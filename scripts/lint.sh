#!/usr/bin/env bash
# Quality gate. NOTE: this repo has no standalone linter; the closest single
# check is the local consistency guard (counts / version drift across files).
# The authoritative pre-PR gate is `npm run pre-pr` (consistency + build + test).
set -euo pipefail
exec npm run check:consistency-local -- "$@"
