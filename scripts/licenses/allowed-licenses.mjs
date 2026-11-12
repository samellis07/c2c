/**
 * The single project licence allowlist for every shipped tree: the vendored plugin closure, the generated function runtime
 * deps, the generated React app template, and any Studio bundle later.
 *
 * `scripts/vendor-plugin.mjs` and `tools/licence-gate.mjs` both import from
 * here; do not define a second copy.
 *
 * Anything outside the list (GPL, AGPL, LGPL, SSPL, non-OSI, unparseable)
 * ships only with an `APPROVED` entry in scripts/licenses/exceptions.json.
 */
export const SHIPPED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Unlicense',
]);

/**
 * Evaluate an npm `license` string against SHIPPED_LICENSES.
 *
 * Returns true only when the expression PROVES an allowed licence:
 * `A OR B` passes if either side passes (the recipient may choose A);
 * `A AND B` passes only if both sides pass; `X WITH <exc>` is judged on X,
 * because an exception only relaxes X's conditions. Bare identifiers must be
 * an exact SPDX id from the allowlist. Anything unparseable returns false.
 *
 * @param {unknown} expression package.json license (string) or licence id
 * @returns {boolean}
 */
export function licenseAllowed(expression) {
  if (typeof expression !== 'string') return false;
  const tokens = tokenize(expression);
  if (!tokens.length) return false;
  const parsed = parseExpression(tokens);
  return parsed !== undefined && parsed.pos === tokens.length && parsed.allowed;
}

function tokenize(expression) {
  const tokens = [];
  const re = /\s*(\(|\)|[^\s()]+)\s*/gy;
  let match;
  while ((match = re.exec(expression)) !== null) tokens.push(match[1]);
  return tokens;
}

function parseExpression(tokens, pos = 0) {
  let state = parseTerm(tokens, pos);
  if (state === undefined) return undefined;
  while (state.pos < tokens.length && /^or$/i.test(tokens[state.pos])) {
    const rhs = parseTerm(tokens, state.pos + 1);
    if (rhs === undefined) return undefined;
    state = { pos: rhs.pos, allowed: state.allowed || rhs.allowed };
  }
  return state;
}

function parseTerm(tokens, pos) {
  let state = parseFactor(tokens, pos);
  if (state === undefined) return undefined;
  while (state.pos < tokens.length && /^and$/i.test(tokens[state.pos])) {
    const rhs = parseFactor(tokens, state.pos + 1);
    if (rhs === undefined) return undefined;
    state = { pos: rhs.pos, allowed: state.allowed && rhs.allowed };
  }
  return state;
}

function parseFactor(tokens, pos) {
  if (pos >= tokens.length) return undefined;
  const token = tokens[pos];
  if (token === '(') {
    const inner = parseExpression(tokens, pos + 1);
    if (inner === undefined || inner.pos >= tokens.length || tokens[inner.pos] !== ')') return undefined;
    return { pos: inner.pos + 1, allowed: inner.allowed };
  }
  if (token === ')' || /^(and|or)$/i.test(token)) return undefined;
  let end = pos + 1;
  // `LicenseRef-...` and `DocumentRef-...` can never be proven allowed.
  if (/^(LicenseRef|DocumentRef)/.test(token)) return { pos: end, allowed: false };
  if (end < tokens.length && /^with$/i.test(tokens[end])) {
    if (end + 1 >= tokens.length || /^(and|or|\(|\))$/i.test(tokens[end + 1])) return undefined;
    end += 2; // skip the exception name; judged on the base licence
  }
  const id = token.endsWith('+') ? token.slice(0, -1) : token;
  return { pos: end, allowed: SHIPPED_LICENSES.has(id) };
}

/**
 * Normalise the licence field(s) of an installed package.json to one SPDX-ish
 * string for reporting. Returns undefined when no licence is declared.
 */
export function licenseOf(pkg) {
  if (typeof pkg?.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (typeof pkg?.license === 'object' && typeof pkg.license?.type === 'string') return pkg.license.type.trim();
  if (Array.isArray(pkg?.licenses)) {
    const parts = pkg.licenses.map((entry) => (typeof entry === 'string' ? entry : entry?.type)).filter(Boolean);
    if (parts.length === 1) return parts[0];
    if (parts.length > 1) return `(${parts.join(' OR ')})`;
  }
  return undefined;
}
