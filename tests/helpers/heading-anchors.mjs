/**
 * Shared heading-anchor slug algorithm for link-checker tests.
 *
 * Used by tests/docs/links.test.mjs and tests/plugin/links.test.mjs so the
 * slug rule exists in exactly one place. Mirrors the hosted docs
 * heading-anchor rule: lowercase, drop punctuation except - and _, then turn
 * every remaining space into a hyphen. Duplicate headings get a -N suffix
 * (first duplicate is -1), matching the renderer.
 */
export function anchorFor(heading) {
  return heading
    .replace(/\s+#+\s*$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

export function headingAnchors(markdown) {
  const anchors = new Set();
  const counts = new Map();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (!match) continue;
    let slug = anchorFor(match[2]);
    const seen = counts.get(slug) ?? 0;
    counts.set(slug, seen + 1);
    if (seen > 0) slug = `${slug}-${seen}`;
    anchors.add(slug);
  }
  return anchors;
}

export function documentAnchors(markdown) {
  const anchors = headingAnchors(markdown);
  for (const match of markdown.matchAll(/<a\s+(?:id|name)="([^"]+)"\s*>/g)) {
    anchors.add(match[1].replace(/^user-content-/, ''));
  }
  return anchors;
}
