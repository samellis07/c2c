/**
 * Corpus harness: round-trip every `.ds` file under a directory and summarise.
 *
 * The summary holds aggregate numbers only. It never includes file contents,
 * file names, paths or URLs, so it is safe to share even when the corpus is
 * private. Unknown-construct keywords are only reported when they look like a
 * Creator keyword (lower-case words); anything else is shown as `<name>`.
 */
import { readFileSync } from 'node:fs';
import { compareEnUs } from './order.js';
import { addCoverage, emptyCoverage, safeKeyword } from './coverage.js';
import { print, walkStatements } from './cst.js';
import { listDsFiles, parseFile } from './parse.js';
import { encode, LockedExportError } from './source.js';
export function runCorpus(dir) {
    const s = {
        files: 0,
        bytes: 0,
        roundTripOk: 0,
        roundTripFail: 0,
        failureReasons: {},
        shapes: { A: 0, B: 0, C: 0, deluge: 0, empty: 0, unknown: 0 },
        encodings: {},
        statements: 0,
        unknownNodes: 0,
        cstStatements: 0,
        cstUnknown: 0,
        unmodelledBlocks: 0,
        unknownBytes: 0,
        filesWithUnknown: 0,
        unknownCategories: {},
        structuralIssues: { 'stray-closer': 0, 'unclosed-bracket': 0, 'bad-token': 0 },
        filesWithStructuralIssues: 0,
        coverage: emptyCoverage(),
        ir: { forms: 0, fields: 0, reports: 0, pages: 0, workflows: 0, delugeSpans: 0, functions: 0, permissions: 0 },
    };
    const bump = (m, k, by = 1) => (m[k] = (m[k] ?? 0) + by);
    for (const path of listDsFiles(dir)) {
        s.files++;
        let original;
        try {
            original = readFileSync(path);
        }
        catch (e) {
            s.roundTripFail++;
            bump(s.failureReasons, `read error (${e.code ?? 'unknown'})`);
            continue;
        }
        s.bytes += original.length;
        try {
            const f = parseFile(path);
            bump(s.encodings, f.encoding);
            const printed = encode(print(f.cst), f.encoding);
            if (printed.equals(original))
                s.roundTripOk++;
            else {
                s.roundTripFail++;
                bump(s.failureReasons, printed.length === original.length ? 'byte mismatch (same length)' : 'byte mismatch (length differs)');
            }
            s.shapes[f.ir.shape]++;
            s.statements += f.ir.statementCount;
            s.unknownNodes += f.ir.unknown.length;
            if (f.ir.unknown.length)
                s.filesWithUnknown++;
            for (const u of f.ir.unknown) {
                s.unknownBytes += u.span.end - u.span.start;
                bump(s.unknownCategories, `${u.context} / ${u.cstKind} / ${safeKeyword(u.keyword)}`);
            }
            walkStatements(f.cst, (st) => {
                s.cstStatements++;
                if (st.kind === 'unknown')
                    s.cstUnknown++;
            });
            addCoverage(s.coverage, f.cst, f.roles);
            s.unmodelledBlocks += f.ir.unmodelled.length;
            if (f.cst.errors.length)
                s.filesWithStructuralIssues++;
            for (const e of f.cst.errors)
                s.structuralIssues[e.code]++;
            s.ir.forms += f.ir.forms.length;
            s.ir.fields += f.ir.forms.reduce((n, x) => n + x.fields.length, 0);
            s.ir.reports += f.ir.reports.length;
            s.ir.pages += f.ir.pages.length;
            s.ir.workflows += f.ir.workflows.length;
            s.ir.delugeSpans +=
                f.ir.workflows.filter((w) => w.deluge).length + f.ir.functions.reduce((n, x) => n + x.deluge.length, 0);
            s.ir.functions += f.ir.functions.length;
            s.ir.permissions += f.ir.permissions.length;
        }
        catch (e) {
            // A locked Marketplace page is a refusal, not a round-trip miss. Let the
            // CLI exit 2 instead of scoring the HTML as an empty app.
            if (e instanceof LockedExportError)
                throw e;
            s.roundTripFail++;
            bump(s.failureReasons, `exception: ${e.name}`);
        }
    }
    return s;
}
const pct = (a, b) => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(2)}%`);
function top(m, n) {
    return Object.entries(m)
        .sort((a, b) => b[1] - a[1] || compareEnUs(a[0], b[0]))
        .slice(0, n);
}
export function formatSummary(label, s, topN = 20) {
    const lines = [];
    lines.push(`### ${label}`, '');
    lines.push('| metric | value |', '|---|---|');
    lines.push(`| .ds files | ${s.files} |`);
    lines.push(`| bytes | ${s.bytes} |`);
    lines.push(`| round-trip OK | ${s.roundTripOk} / ${s.files} (${pct(s.roundTripOk, s.files)}) |`);
    lines.push(`| round-trip FAIL | ${s.roundTripFail} |`);
    lines.push(`| shapes A / B / C / bare Deluge / empty / unrecognised | ${s.shapes.A} / ${s.shapes.B} / ${s.shapes.C} / ${s.shapes.deluge} / ${s.shapes.empty} / ${s.shapes.unknown} |`);
    lines.push(`| encodings | ${Object.entries(s.encodings).map(([k, v]) => `${k} ${v}`).join(', ') || '-'} |`);
    lines.push(`| statements at modelled levels | ${s.statements} |`);
    lines.push(`| Unknown nodes | ${s.unknownNodes} (${pct(s.unknownNodes, s.statements)} of statements) |`);
    lines.push(`| all CST statements (incl. inside reports, fields, unmodelled blocks) | ${s.cstStatements} |`);
    lines.push(`| CST statements matching no statement shape | ${s.cstUnknown} (${pct(s.cstUnknown, s.cstStatements)}) |`);
    lines.push(`| known blocks preserved but not modelled in the IR | ${s.unmodelledBlocks} |`);
    lines.push(`| bytes inside Unknown nodes | ${s.unknownBytes} (${pct(s.unknownBytes, s.bytes)} of bytes) |`);
    lines.push(`| files with at least one Unknown node | ${s.filesWithUnknown} |`);
    lines.push(`| files with bracket/token issues | ${s.filesWithStructuralIssues} (stray closer ${s.structuralIssues['stray-closer']}, unclosed ${s.structuralIssues['unclosed-bracket']}, bad token ${s.structuralIssues['bad-token']}) |`);
    lines.push(`| IR: forms / fields / reports / pages | ${s.ir.forms} / ${s.ir.fields} / ${s.ir.reports} / ${s.ir.pages} |`);
    lines.push(`| IR: workflows / functions / raw Deluge spans / permissions | ${s.ir.workflows} / ${s.ir.functions} / ${s.ir.delugeSpans} / ${s.ir.permissions} |`);
    lines.push('');
    const fails = top(s.failureReasons, 5);
    lines.push('Top round-trip failure reasons:', '');
    if (fails.length === 0)
        lines.push('- none');
    for (const [k, v] of fails)
        lines.push(`- ${k}: ${v}`);
    lines.push('');
    const unk = top(s.unknownCategories, 10);
    lines.push('Top Unknown-node categories (context / CST kind / keyword):', '');
    if (unk.length === 0)
        lines.push('- none');
    for (const [k, v] of unk)
        lines.push(`- ${k}: ${v}`);
    lines.push('');
    lines.push(...formatCoverage(s.coverage, topN));
    return lines.join('\n');
}
export function formatCoverage(c, topN = 20) {
    const lines = [];
    lines.push('IR coverage (CST statements represented in the IR vs preserved only in the CST):', '');
    lines.push('| construct | modelled | preserved only | modelled % |', '|---|---|---|---|');
    const row = (k, m, t) => lines.push(`| ${k} | ${m} | ${t - m} | ${pct(m, t)} |`);
    row('all statements', c.modelled, c.statements);
    row('blocks (`{}` and `()` bodies)', c.blocksModelled, c.blocks);
    for (const k of ['property', 'block', 'call', 'word', 'pairs', 'group', 'unknown']) {
        const v = c.byCstKind[k];
        if (v)
            row(`CST kind \`${k}\``, v[0], v[0] + v[1]);
    }
    lines.push('');
    lines.push(`Top ${topN} preserved-only statement kinds (nearest modelled role > keyword path; <name> = identifier):`, '');
    const um = top(c.unmodelled, topN);
    if (um.length === 0)
        lines.push('- none');
    for (const [k, v] of um)
        lines.push(`- \`${k}\`: ${v}`);
    lines.push('');
    return lines;
}
