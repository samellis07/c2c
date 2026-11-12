#!/usr/bin/env bash
# Merge driver for c2c generated artifacts (.gitattributes: merge=c2c-generated).
# Install once per clone: bash tools/install-merge-driver.sh
#
# git calls: <driver> %O %A %B %L %P  (we take ancestor current other path).
# %A is where the merged result belongs. For a generated file neither --ours nor
# --theirs is ever right: pick a side and you silently revert the other side's
# source changes inside the same derived file. So:
#
#   1. The driver never runs code during an ordinary merge or rebase: it
#      union-merges so no side is dropped, and the freshness checks fail stale
#      until you run the documented regen command.
#   2. Gallery docs are regenerated only when you explicitly opt in with
#      C2C_MERGE_REGENERATE=1 for that merge command and the gallery inputs
#      are present; never sweep during an ordinary merge or rebase.
set -u

ancestor="${1:?ancestor}"
current="${2:?current}"
other="${3:?other}"
path="${4:-${MERGE_HEAD_PATH:-}}"

root="$(git rev-parse --show-toplevel 2>/dev/null)" || root="$(pwd)"
cd "$root" || exit 1

emit() { printf 'merge-generated: %s\n' "$*" >&2; }

union() {
  tmp="$(mktemp "${TMPDIR:-/tmp}/c2c-merge-generated.XXXXXX")"
  git merge-file --union -p "$current" "$ancestor" "$other" >"$tmp" || {
    rm -f "$tmp"
    emit "union merge failed for $path; resolve by regenerating"
    exit 1
  }
  cat "$tmp" >"$current"
  rm -f "$tmp"
  emit "union-merged $path (regeneration inputs unavailable); run the regen command for this file before committing"
  exit 0
}

# Copy a regenerated worktree file back as the merge result.
take() { cat "$path" >"$current"; emit "regenerated $path"; exit 0; }

gallery_dir() {
  if [ -n "${C2C_GALLERY_DIR:-}" ]; then printf '%s' "$C2C_GALLERY_DIR";
  elif [ -n "${C2C_FIXTURES_DIR:-}" ]; then printf '%s' "$C2C_FIXTURES_DIR/gallery"; fi
}

case "$path" in
  packages/determinism/test/manifests/*.sha256)
    # Union-merge only: a merge must not run repo code or rewrite files beyond
    # %A. determinism:check flags the union as stale; regenerate with
    # npm run determinism:update.
    union ;;
  docs/determinism-status.md)
    if [ "${C2C_MERGE_REGENERATE:-}" = "1" ] && [ -f dist/determinism/src/status.js ] && [ -n "$(gallery_dir)" ]; then
      node dist/determinism/src/status.js >/dev/null 2>&1 && take
    fi
    union ;;
  docs/decimal-audit.md)
    gal="$(gallery_dir)"
    if [ "${C2C_MERGE_REGENERATE:-}" = "1" ] && [ -f dist/determinism/src/decimal-audit.js ] && [ -n "$gal" ] && [ -d "$gal" ]; then
      node dist/determinism/src/decimal-audit.js "$gal" >"$path" 2>/dev/null && take
    fi
    union ;;
  docs/quality-gate.md)
    gal="$(gallery_dir)"
    if [ "${C2C_MERGE_REGENERATE:-}" = "1" ] && [ -f dist/quality/src/gallery.js ] && [ -n "$gal" ] && [ -d "$gal" ]; then
      block="$(C2C_GALLERY_DIR="$gal" node dist/quality/src/gallery.js --markdown 2>/dev/null)"
      if [ -n "$block" ]; then
        # Replace the marked block in the merged file; markers carry a digest, so
        # splicing both markers from the regenerated block keeps the doc coherent.
        tmpblock="$(mktemp "${TMPDIR:-/tmp}/c2c-quality-block.XXXXXX")"
        printf '%s' "$block" >"$tmpblock"
        if node -e '
          const fs = require("node:fs");
          const [file, blockFile] = process.argv.slice(1);
          const doc = fs.readFileSync(file, "utf8");
          const block = fs.readFileSync(blockFile, "utf8");
          const begin = "<!-- quality-gallery:begin", end = "<!-- quality-gallery:end -->";
          const b = doc.indexOf(begin), e = doc.indexOf(end);
          if (b < 0 || e <= b) process.exit(1);
          fs.writeFileSync(file, doc.slice(0, b) + block + doc.slice(e + end.length + 1));
        ' "$path" "$tmpblock" 2>/dev/null; then
          rm -f "$tmpblock"
          take
        fi
        rm -f "$tmpblock"
      fi
    fi
    union ;;
  *)
    # A generated-looking path this driver does not know: still never pick a side.
    union ;;
esac
