/**
 * Pinned toolchain recorded in generated output.
 * Node comes from package.json engines. TypeScript comes from the installed package.
 * Both must match package.json (exact typescript, engines.node).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
let cached;
export function repoRoot() {
    return join(dirname(fileURLToPath(import.meta.url)), '../../..');
}
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
/**
 * Pins from the package.json at root. The installed plugin tree ships
 * package.json but no .nvmrc and no node_modules, so this is the only source
 * there. Values that are not exact versions are not pins.
 */
function packageJsonPins(root) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const node = pkg.engines?.node;
    const typescript = pkg.devDependencies?.typescript;
    return {
        ...(node && EXACT_VERSION.test(node) ? { node } : {}),
        ...(typescript && EXACT_VERSION.test(typescript) ? { typescript } : {}),
    };
}
export function toolchain() {
    if (cached)
        return cached;
    const root = repoRoot();
    let node;
    try {
        node = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
    }
    catch {
        // No .nvmrc at root; the package.json pins are read below.
    }
    let typescript;
    try {
        const require = createRequire(import.meta.url);
        typescript = require('typescript/package.json').version;
    }
    catch {
        // No installed typescript package at root; the package.json pins are read below.
    }
    if (node === undefined || typescript === undefined) {
        const pins = packageJsonPins(root);
        // The vendored plugin has no .nvmrc and engines.node is a range, not a pin: the pinned release.
        node ??= pins.node ?? '20.20.1';
        typescript ??= pins.typescript;
    }
    if (node === undefined || typescript === undefined) {
        throw new Error('toolchain pins missing: no .nvmrc, no installed typescript, no package.json pins');
    }
    cached = { node, typescript };
    return cached;
}
/** Plain header written as c2c-build.txt in a generated tree. */
export function toolchainHeader() {
    const pin = toolchain();
    return `c2c generated output\nnode: ${pin.node}\ntypescript: ${pin.typescript}\n`;
}
/** Lines appended to every generated module banner. */
export function toolchainBannerLines() {
    const pin = toolchain();
    return [`node: ${pin.node}`, `typescript: ${pin.typescript}`];
}
/**
 * The Node versions the React UI target builds on: the pinned Vite's own
 * engines range. It is the single source for the emitted web/package.json
 * (and lockfile root) `engines.node`, which npm enforces with engine-strict,
 * and for the doctor's D-R1 check, so a green doctor means `npm ci` runs.
 */
export const REACT_BUILD_NODE_RANGE = '^20.19.0 || >=22.12.0';
/**
 * Whether a Node version (`v22.12.0` or `22.12.0`) satisfies a range written
 * as `||`-joined alternatives; each alternative is space-separated terms that
 * ALL must hold — `^x.y.z`, `>=`, `<=`, `>`, `<` comparators (partial bounds
 * like `<23` read as `23.0.0`) or an exact `x.y.z`. These are the forms
 * REACT_BUILD_NODE_RANGE and the repo `engines.node` use. An unparsable
 * version or term never matches.
 */
export function nodeSatisfies(version, range) {
    const parse = (text, partial = false) => {
        const pattern = partial ? /^v?([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?$/ : /^v?([0-9]+)\.([0-9]+)\.([0-9]+)$/;
        const m = pattern.exec(text.trim());
        return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : undefined;
    };
    const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    const v = parse(version);
    if (!v)
        return false;
    const satisfiesTerm = (term) => {
        const op = ['>=', '<=', '>', '<', '^'].find((o) => term.startsWith(o)) ?? '';
        const bound = parse(term.slice(op.length), op !== '');
        if (!bound)
            return false;
        switch (op) {
            case '>=':
                return cmp(v, bound) >= 0;
            case '<=':
                return cmp(v, bound) <= 0;
            case '>':
                return cmp(v, bound) > 0;
            case '<':
                return cmp(v, bound) < 0;
            case '^':
                return v[0] === bound[0] && cmp(v, bound) >= 0;
            default:
                return cmp(v, bound) === 0;
        }
    };
    return range.split('||').some((alt) => {
        const terms = alt.trim().split(/\s+/).filter(Boolean);
        return terms.length > 0 && terms.every(satisfiesTerm);
    });
}
