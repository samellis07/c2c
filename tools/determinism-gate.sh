#!/usr/bin/env bash
# Determinism gate: generate every committed fixture's full output tree twice,
# each run in a fresh process writing into its own clean directory, hash every
# file, and fail on any difference. Offline; needs `npm run build` first.
#
#   bash tools/determinism-gate.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
gallery="dist/determinism/src/gallery.js"
[ -f "$gallery" ] || { echo "determinism-gate: run npm run build first" >&2; exit 2; }

work="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/c2c-determinism-gate.XXXXXX")"
trap 'rm -rf "$work"' EXIT

fixtures=()
for dir in fixtures/redistributable/*/; do fixtures+=("${dir%/}"); done
[ "${#fixtures[@]}" -gt 0 ] || { echo "determinism-gate: no committed fixtures" >&2; exit 2; }

for run in a b; do
  for fixture in "${fixtures[@]}"; do
    out="$work/$run/$(basename "$fixture")"
    mkdir -p "$out"
    node "$gallery" --write "$fixture" "$out"
  done
  # "<sha256>  <path>" per file, paths relative to the run dir, sorted bytewise.
  node -e '
    const { createHash } = require("node:crypto");
    const { readdirSync, readFileSync } = require("node:fs");
    const { join, relative } = require("node:path");
    const base = process.argv[1];
    const out = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else out.push(`${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${relative(base, path)}`);
      }
    };
    walk(base);
    out.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : a.slice(66) > b.slice(66) ? 1 : 0));
    process.stdout.write(out.join("\n") + "\n");
  ' "$work/$run" >"$work/$run.sha256"
done

files="$(wc -l <"$work/a.sha256" | tr -d ' ')"
[ "$files" -gt 0 ] || { echo "determinism-gate: run produced no files" >&2; exit 1; }
if ! diff -u "$work/a.sha256" "$work/b.sha256"; then
  echo "determinism-gate: FAIL — two clean runs differ (diff above)" >&2
  exit 1
fi
echo "determinism-gate: fixtures=${#fixtures[@]} files=$files tree-sha256=$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$work/a.sha256") runs=identical"
