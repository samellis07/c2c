#!/usr/bin/env bash
# One-time per-clone setup: register the c2c-generated merge driver so git
# resolves generated artifacts via tools/merge-generated.sh instead of leaving
# conflict markers in files that must be regenerated, never hand-merged.
# Idempotent. Reversible with: git config --unset merge.c2c-generated.driver
set -euo pipefail

git config merge.c2c-generated.name 'c2c generated artifact regenerator'
git config merge.c2c-generated.driver 'bash tools/merge-generated.sh %O %A %B %P'
echo "merge.c2c-generated installed: $(git config --get merge.c2c-generated.driver)"
