/**
 * IR coverage: which CST statements the IR models, and which are only preserved.
 *
 * Every statement is in the CST (round-trip is lossless by construction). A
 * statement is *modelled* when the deriver turned it into IR (a typed node, a
 * property on a typed node, or a raw Deluge span); otherwise it is
 * *preserved-only*: still in the CST, but invisible to generators.
 *
 * Kind names are built from roles and Creator keywords only. A header word that
 * is not a lower-case keyword is shown as `<name>`, so a summary never carries
 * identifiers, strings or other file contents.
 */
import { headerWords, isGroup, isStatement, sig } from './cst.js';
export function emptyCoverage() {
    return { statements: 0, modelled: 0, blocks: 0, blocksModelled: 0, byCstKind: {}, byRole: {}, unmodelled: {} };
}
const SAFE_KEYWORD = /^[a-z][a-z ]{0,30}$/;
export function safeKeyword(k) {
    if (!k)
        return '-';
    return SAFE_KEYWORD.test(k) ? k : '<name>';
}
/** A content-free label for a statement: its keyword(s), or its shape. */
export function statementLabel(s) {
    const ws = headerWords(s).map((t) => t.text);
    switch (s.kind) {
        case 'property':
            return `${safeKeyword(ws.join(' '))} =`;
        case 'pairs':
            return `${safeKeyword(ws.join(' '))} :`;
        case 'block':
        case 'call': {
            const kw = safeKeyword(ws.join(' '));
            if (kw !== '<name>')
                return `${kw} ${s.kind === 'block' ? '{}' : '()'}`;
            // keyword(s) followed by a name: `form X`, `list Y`, `on user input of F`
            const lead = [];
            for (const w of ws) {
                if (!SAFE_KEYWORD.test(w))
                    break;
                lead.push(w);
            }
            return `${lead.length ? lead.join(' ') + ' ' : ''}<name> ${s.kind === 'block' ? '{}' : '()'}`;
        }
        case 'word':
            return 'word';
        case 'group': {
            const g = sig(s)[0];
            return isGroup(g) ? `${g.open.text}…` : 'group';
        }
        default:
            return '?';
    }
}
/** Add one file's coverage to `cov`. `roles` comes from `deriveIr`. */
export function addCoverage(cov, doc, roles) {
    const bump = (m, k) => (m[k] = (m[k] ?? 0) + 1);
    const walk = (stmts, path) => {
        for (const s of stmts) {
            const role = roles.get(s);
            cov.statements++;
            const isBlock = s.kind === 'block' || s.kind === 'call';
            if (isBlock)
                cov.blocks++;
            const k = (cov.byCstKind[s.kind] ??= [0, 0]);
            let next;
            if (role) {
                cov.modelled++;
                if (isBlock)
                    cov.blocksModelled++;
                k[0]++;
                bump(cov.byRole, role);
                next = [role];
            }
            else {
                k[1]++;
                const label = statementLabel(s);
                // nearest modelled role, the outermost and innermost preserved ancestors, the statement
                const anc = path.slice(1);
                const shown = anc.length <= 2 ? anc : [anc[0], '…', anc[anc.length - 1]];
                const kind = [path[0], ...shown, label].join(' > ');
                bump(cov.unmodelled, kind);
                next = [...path, label];
            }
            for (const g of s.children)
                if (isGroup(g) && g.structured)
                    walk(g.children.filter(isStatement), next);
        }
    };
    walk(doc.children.filter(isStatement), ['document']);
    return cov;
}
export function mergeCoverage(into, c) {
    into.statements += c.statements;
    into.modelled += c.modelled;
    into.blocks += c.blocks;
    into.blocksModelled += c.blocksModelled;
    for (const [k, [m, p]] of Object.entries(c.byCstKind)) {
        const t = (into.byCstKind[k] ??= [0, 0]);
        t[0] += m;
        t[1] += p;
    }
    for (const [k, v] of Object.entries(c.byRole))
        into.byRole[k] = (into.byRole[k] ?? 0) + v;
    for (const [k, v] of Object.entries(c.unmodelled))
        into.unmodelled[k] = (into.unmodelled[k] ?? 0) + v;
    return into;
}
