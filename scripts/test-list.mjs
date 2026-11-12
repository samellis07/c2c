/**
 * Reads the npm test target list: one path per line. A blank line is ignored.
 * A line whose first non-space character is `#` is a comment.
 */
import { readFileSync } from 'node:fs';

export function normalizeTestPath(path) {
  let normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  return normalized;
}

/** @returns {{ path: string, line: number }[]} paths in file order, including duplicates. */
export function readTestListLines(text) {
  const entries = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === '' || raw.startsWith('#')) continue;
    entries.push({ path: normalizeTestPath(raw), line: i + 1 });
  }
  return entries;
}

/**
 * @param {string} text
 * @param {string} label filename shown in errors
 * @returns {{ path: string, line: number }[]}
 */
export function parseTestList(text, label = 'test list') {
  const entries = readTestListLines(text);
  const seen = new Map();
  for (const entry of entries) {
    const first = seen.get(entry.path);
    if (first !== undefined) {
      throw new Error(`${label}:${entry.line}: duplicate path ${entry.path} (first at line ${first})`);
    }
    seen.set(entry.path, entry.line);
  }
  return entries;
}

export function loadTestList(filePath, label = filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${label}: ${err.message}`);
  }
  return parseTestList(text, label);
}
