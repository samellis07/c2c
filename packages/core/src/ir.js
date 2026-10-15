/**
 * IR v1: a typed application model derived from the lossless CST.
 *
 * The IR is a *view* over the CST: every node carries the source span it came
 * from, and anything the deriver does not understand at a modelled level is
 * listed in `unknown[]` with its exact span and text. Embedded Deluge is kept
 * as a raw span. The schema is documented in docs/ir-v1.md.
 *
 * The deriver also records, per CST statement, the IR role it was turned into
 * (`roles`). Statements without a role are preserved in the CST only; the
 * corpus harness reports them as the coverage gap (see coverage.ts).
 */
import { headerWords, isGroup, isStatement, isToken, sig, } from './cst.js';
import { parseZml, zmlReferences } from './zml.js';
import { detectDialect, normaliseDialect } from './dialect.js';
export const IR_VERSION = 1;
// ---------------------------------------------------------------------------
// helpers
export function unquote(s) {
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
        return s.slice(1, -1).replace(/\\(.)/gs, (_m, c) => c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c);
    }
    return s;
}
/**
 * Static Creator initial value as literal text, or undefined. The
 * gallery apps carry only static literals (quoted strings, numbers,
 * percents, times, true/false); anything shaped like a dynamic expression
 * (zoho.loginuser, zoho.currentdate, arithmetic) is left unset, so neither
 * the submit handler nor a table-create default_value ever stores
 * expression source as a cell. A doubled quote inside a quoted literal
 * ('it''s') is one literal quote.
 */
export function staticDefault(raw) {
    if (raw === undefined)
        return undefined;
    const text = raw.trim();
    if (/^"([^"\\]|\\.|"")*"$/.test(text))
        return unquote(text).replace(/""/g, '"');
    if (/^'([^'\\]|\\.|'')*'$/.test(text))
        return unquote(text).replace(/''/g, "'");
    if (/^(true|false)$/i.test(text))
        return text.toLowerCase();
    if (/^[+-]?[0-9][0-9:.%]*(?:-[0-9:.%]+)*$/.test(text))
        return text;
    return undefined;
}
const REPORT_TYPES = new Set([
    'list',
    'kanban',
    'pivottable',
    'pivotchart',
    'summary',
    'calendar',
    'grid',
    'spreadsheet',
    'timeline',
    'map',
    'chart',
    'report',
    'sheet',
    'gantt',
    'custom',
]);
/** Form-level settings blocks, modelled as `Form.blocks`. */
const FORM_BLOCKS = new Set([
    'customize',
    'print template',
    'properties',
    'title',
    'blueprint components',
    'record summary',
    'enable payment',
    'disable payment',
]);
/** Report-level settings blocks, modelled as `Report.blocks`. */
const REPORT_BLOCKS = new Set(['options', 'report properties', 'permission', 'customlayouts']);
/** Application-level settings blocks, modelled as `App.configuration`. */
const CONFIG_BLOCKS = new Set([
    'customize',
    'settings',
    'preference',
    'theme',
    'connections',
    'reports configuration',
    'datasources',
    'variables',
]);
const DEVICES = new Set(['web', 'phone', 'tablet']);
const EVENT_RE = /^on\b/;
/** Record that statement `s` is represented in the IR as `role`. */
function claim(ctx, s, role) {
    if (!ctx.roles.has(s))
        ctx.roles.set(s, role);
}
/** Claim every statement in a subtree (a construct kept whole, e.g. a bare Deluge file). */
function claimAll(ctx, s, role) {
    claim(ctx, s, role);
    for (const c of children(s))
        claimAll(ctx, c, role);
}
/** Claim the statements that hold raw Deluge, and the structured statements between them and `s`. */
function claimDeluge(ctx, s) {
    let has = false;
    for (const g of s.children) {
        if (!isGroup(g))
            continue;
        if (g.raw)
            has = true;
        else if (g.structured)
            for (const c of g.children)
                if (isStatement(c) && claimDeluge(ctx, c))
                    has = true;
    }
    if (has)
        claim(ctx, s, 'deluge');
    return has;
}
function span(ctx, n) {
    return ctx.file ? { start: n.start, end: n.end, file: ctx.file } : { start: n.start, end: n.end };
}
function text(ctx, n) {
    return ctx.src.slice(n.start, n.end);
}
function words(s) {
    return headerWords(s).map((t) => t.text);
}
function lower(ws) {
    return ws.map((w) => w.toLowerCase());
}
/** The structured body of a block/call statement (its last structured group). */
function body(s) {
    for (const g of [...s.children].reverse()) {
        if (isGroup(g) && g.structured)
            return g.children.filter(isStatement);
    }
    return [];
}
/** Statements in every structured group of `s`. */
function children(s) {
    const out = [];
    for (const g of s.children)
        if (isGroup(g) && g.structured)
            for (const c of g.children)
                if (isStatement(c))
                    out.push(c);
    return out;
}
/** The last structured group of a statement. */
function bodyGroup(s) {
    for (const g of [...s.children].reverse())
        if (isGroup(g) && g.structured)
            return g;
    return undefined;
}
/** Text between a group's brackets. */
function inside(ctx, g) {
    return ctx.src.slice(g.open.start + g.open.text.length, g.close ? g.close.start : g.end);
}
function property(ctx, s) {
    const items = sig(s);
    const isSep = (x, t) => isToken(x) && x.kind === 'punct' && x.text === t;
    // `key : value` (payment settings, sendmail-like attribute lists) when it holds exactly one pair
    if (s.kind === 'pairs' && items.filter((x) => isSep(x, ':')).length !== 1)
        return null;
    if (s.kind !== 'property' && s.kind !== 'pairs')
        return null;
    const eq = items.findIndex((x) => isSep(x, s.kind === 'pairs' ? ':' : '='));
    const keyWords = items.slice(0, eq).map((x) => x.text);
    let valueItems = items.slice(eq + 1);
    const last = valueItems[valueItems.length - 1];
    if (last && isToken(last) && last.text === ';')
        valueItems = valueItems.slice(0, -1);
    const value = valueItems.length
        ? ctx.src.slice(nodeStartOf(valueItems[0]), nodeEndOf(valueItems[valueItems.length - 1]))
        : '';
    return { key: keyWords.join(' '), value, span: span(ctx, s) };
}
function nodeStartOf(n) {
    return isToken(n) ? n.start : n.start;
}
function nodeEndOf(n) {
    return isToken(n) ? n.start + n.text.length : n.end;
}
/** Properties of a body. With `role`, the property statements are claimed as modelled. */
function props(ctx, stmts, role) {
    const out = [];
    for (const s of stmts) {
        const p = property(ctx, s);
        if (!p)
            continue;
        out.push(p);
        if (role)
            claim(ctx, s, role);
    }
    return out;
}
function prop(ps, key) {
    const p = ps.find((x) => x.key.toLowerCase() === key);
    return p ? unquote(p.value) : undefined;
}
/** Name and label from `Name`, `Name as "Label"`, `"Name"`. */
function nameAndLabel(ws) {
    const as = ws.findIndex((w, i) => i > 0 && w.toLowerCase() === 'as');
    if (as > 0 && as === ws.length - 2) {
        return { name: unquote(ws[as - 1]), label: unquote(ws[as + 1]), rest: ws.slice(0, as - 1) };
    }
    return { name: unquote(ws[ws.length - 1] ?? ''), rest: ws.slice(0, -1) };
}
function firstRaw(g) {
    for (const n of g) {
        if (isGroup(n)) {
            if (n.raw)
                return n;
            const inner = firstRaw(n.children);
            if (inner)
                return inner;
        }
        else if (isStatement(n)) {
            const inner = firstRaw(n.children);
            if (inner)
                return inner;
        }
    }
    return null;
}
function allRaw(g, out = []) {
    for (const n of g) {
        if (isGroup(n)) {
            if (n.raw)
                out.push(n);
            else
                allRaw(n.children, out);
        }
        else if (isStatement(n))
            allRaw(n.children, out);
    }
    return out;
}
function rawDeluge(ctx, g) {
    const start = g.open.start + g.open.text.length;
    const end = g.close ? g.close.start : g.end;
    return { text: ctx.src.slice(start, end), span: span(ctx, { start, end }) };
}
/**
 * The Deluge of an event or function section: its raw groups, or, when the
 * body holds none (2016 exports write actions as structured statements), the
 * whole body verbatim.
 */
function sectionDeluge(ctx, s) {
    const raws = allRaw(s.children);
    if (raws.length && onlyRawPaths(s)) {
        for (const c of children(s))
            claimDeluge(ctx, c);
        return raws.map((g) => rawDeluge(ctx, g));
    }
    const g = bodyGroup(s);
    if (!g || !g.children.some((c) => isStatement(c)))
        return [];
    for (const c of children(s))
        claimAll(ctx, c, 'deluge');
    return [rawDeluge(ctx, g)];
}
/** True when every statement under `s` lies on the way to a raw Deluge group. */
function onlyRawPaths(s) {
    return children(s).every((c) => allRaw(c.children).length > 0 && (c.children.some((x) => isGroup(x) && x.raw) || onlyRawPaths(c)));
}
function unknown(ctx, context, s) {
    const ws = words(s);
    ctx.app.unknown.push({
        context,
        keyword: ws[0],
        cstKind: s.kind,
        span: span(ctx, s),
        text: text(ctx, s),
    });
}
function isBody(s) {
    return (s.kind === 'block' || s.kind === 'call') && bodyGroup(s) !== undefined;
}
/** A settings block: properties and nested settings blocks. Other statements stay preserved-only. */
function propertyBlock(ctx, s, role) {
    claim(ctx, s, role);
    const inner = body(s);
    const block = {
        name: words(s).map(unquote).join(' '),
        properties: props(ctx, inner, `${role}.property`),
        blocks: inner.filter((c) => isBody(c)).map((c) => propertyBlock(ctx, c, role)),
        items: flags(ctx, inner, `${role}.item`),
        span: span(ctx, s),
    };
    if (role === 'api') {
        // `api <name> { actions ( thisapp.<fn>(args) ) }`: the actions script is
        // Deluge, not properties. Keep each unclaimed statement verbatim so the
        // generator can see which functions the custom API publishes over HTTP.
        for (const c of inner) {
            if (ctx.roles.has(c))
                continue;
            claimAll(ctx, c, 'api.deluge');
            (block.deluge ??= []).push({ text: text(ctx, c).trim(), span: span(ctx, c) });
        }
    }
    return block;
}
/** Bare word statements of a body, verbatim (`allow new entries`, `execute action for ...`). */
function flags(ctx, stmts, role) {
    const out = [];
    for (const c of stmts) {
        if (c.kind !== 'word')
            continue;
        claim(ctx, c, role);
        out.push(text(ctx, c).trim());
    }
    return out;
}
/** Item names of a list body: `Edit`, `View Record`, `"Custom action"`. */
function itemList(ctx, s, role) {
    const out = [];
    const g = bodyGroup(s) ?? s.children.find((x) => isGroup(x) && x.raw);
    if (g?.raw) {
        // `on click ( View Record )`: the CST keeps `on click (...)` bodies raw (Deluge elsewhere).
        for (const line of inside(ctx, g).split(/\r\n|\n|\r/)) {
            const t = line.trim();
            if (t)
                out.push(unquote(t));
        }
        return out;
    }
    for (const c of body(s)) {
        if (c.kind !== 'word')
            continue;
        claim(ctx, c, role);
        out.push(words(c).map(unquote).join(' '));
    }
    return out;
}
function visit(ctx, stmts, level, sectionName, owner, space) {
    const app = ctx.app;
    let section;
    if ((level === 'section' || level === 'menu') && sectionName)
        section = app.sections.find((x) => x.name === sectionName);
    for (const s of stmts) {
        app.statementCount++;
        collectPermissions(ctx, s, owner);
        if (s.kind === 'property') {
            const p = property(ctx, s);
            if (level === 'application' || (level === 'document' && !app.name)) {
                app.settings.push(p);
                claim(ctx, s, `${level}.setting`);
            }
            else if ((level === 'section' || level === 'menu') && section)
                claim(ctx, s, 'section.property');
            continue;
        }
        if (s.kind === 'word')
            continue; // bare words carry no structure at these levels
        if (s.kind === 'unknown') {
            unknown(ctx, level, s);
            continue;
        }
        const ws = words(s);
        const lw = lower(ws);
        const kw = lw[0];
        const inner = body(s);
        if (kw === 'application' && s.kind === 'block') {
            app.name = unquote(ws[1] ?? '');
            claim(ctx, s, 'application');
            visit(ctx, inner, 'application');
            continue;
        }
        if ((kw === 'section' || kw === 'space') && s.kind === 'block' && level !== 'form') {
            const ps = props(ctx, inner);
            const name = unquote(ws[1] ?? '');
            if (kw === 'section') {
                const sec = {
                    name,
                    displayName: prop(ps, 'displayname'),
                    icon: prop(ps, 'icon'),
                    hidden: prop(ps, 'hide') === 'true',
                    components: [],
                    properties: ps,
                    ...(space ? { space } : {}),
                    span: span(ctx, s),
                };
                app.sections.push(sec);
                claim(ctx, s, 'section');
                visit(ctx, inner, level === 'menu' ? 'menu' : 'section', name);
            }
            else {
                claim(ctx, s, 'menu.space');
                props(ctx, inner, 'menu.space.property');
                visit(ctx, inner, 'menu', undefined, undefined, name);
            }
            continue;
        }
        if (level === 'menu') {
            // `form X { icon = ... }`, `report Y { ... }` are menu entries, not definitions.
            if (s.kind === 'block' && ws.length === 2 && section) {
                section.components.push({ kind: lw[0], name: ws[1], properties: props(ctx, inner, 'menu.entry.property') });
                claim(ctx, s, 'menu.entry');
            }
            else if (s.kind === 'block' && kw === 'systemcomponent' && section) {
                const ps = props(ctx, inner, 'menu.entry.property');
                section.components.push({ kind: 'systemcomponent', name: prop(ps, 'type') ?? '', properties: ps });
                claim(ctx, s, 'menu.entry');
            }
            else if (s.kind === 'block' && kw === 'preference' && ws.length === 1) {
                app.configuration.push(propertyBlock(ctx, s, 'configuration'));
            }
            continue;
        }
        if (DEVICES.has(kw) && ws.length === 1 && s.kind === 'block' && level === 'application') {
            deriveDevice(ctx, s, kw);
            continue;
        }
        if (ctx.device && level === 'document' && s.kind === 'block' && ws.length === 1 && (kw === 'customize' || kw === 'forms')) {
            // Shape C: `devices/<device>/theme.ds`, `devices/<device>/forms.ds`.
            deriveDeviceBody(ctx, device(ctx, ctx.device, s), [s]);
            continue;
        }
        if (kw === 'form' && s.kind === 'block' && ws.length >= 2 && level !== 'workflow') {
            const form = deriveForm(ctx, s, sectionName);
            claim(ctx, s, 'form');
            const existing = app.forms.find((f) => f.name === form.name);
            if (existing && level === 'container' && form.fields.length === 0)
                existing.properties.push(...form.properties);
            else
                app.forms.push(form);
            section?.components.push({ kind: 'form', name: form.name });
            continue;
        }
        if ((kw === 'forms' || kw === 'reports' || kw === 'pages') && s.kind === 'block' && ws.length === 1) {
            claim(ctx, s, 'container');
            visit(ctx, inner, 'container', sectionName, owner);
            continue;
        }
        if (kw === 'menu' && s.kind === 'block') {
            claim(ctx, s, 'menu');
            visit(ctx, inner, 'menu');
            continue;
        }
        let reportKw = lw.findIndex((w) => REPORT_TYPES.has(w));
        if (reportKw < 0 && s.kind === 'block' && ws.length >= 2 && showFrom(inner))
            reportKw = ws.length - 2;
        if (s.kind === 'block' && reportKw >= 0 && ws.length >= reportKw + 2 && level !== 'workflow' && level !== 'functions' && level !== 'form') {
            const name = ws.slice(reportKw + 1).join('_');
            const report = deriveReport(ctx, s, name, lw[reportKw], lw.slice(0, reportKw), sectionName);
            if (ctx.device)
                for (const v of report.views)
                    v.device = ctx.device;
            app.reports.push(report);
            section?.components.push({ kind: report.type, name: report.name });
            continue;
        }
        if (kw === 'page' && s.kind === 'block' && ws.length === 2) {
            const ps = props(ctx, inner, 'page.property');
            const content = prop(ps, 'content');
            claim(ctx, s, 'page');
            app.pages.push(page(ctx, ws[1], content, ps, s, sectionName));
            section?.components.push({ kind: 'page', name: ws[1] });
            continue;
        }
        if (kw === 'workflow' && s.kind === 'block' && ws.length === 1) {
            claim(ctx, s, 'workflow');
            for (const c of inner) {
                app.statementCount++;
                const cw = lower(words(c));
                if (c.kind === 'block' && cw.length === 1 && cw[0] === 'functions') {
                    claim(ctx, c, 'functions');
                    deriveFunctions(ctx, body(c));
                }
                else if (c.kind === 'block' && cw.length === 1)
                    deriveWorkflowContainer(ctx, c, cw[0]);
                else if (c.kind === 'block' && words(c).length >= 1)
                    deriveWorkflowDef(ctx, c, undefined);
                else if (c.kind !== 'property' && c.kind !== 'word')
                    unknown(ctx, 'workflow', c);
            }
            continue;
        }
        if (kw === 'functions' && s.kind === 'block' && ws.length === 1) {
            claim(ctx, s, 'functions');
            deriveFunctions(ctx, inner);
            continue;
        }
        if (level === 'document' && isSignatureBlock(s)) {
            // Shape C function file: `string name(args) { ... }`.
            app.statementCount--; // counted again by deriveFunctions
            deriveFunctions(ctx, [s]);
            continue;
        }
        if (level === 'document' && s.kind === 'block' && ws.length === 1 && /^["']/.test(ws[0])) {
            // Shape C profile file: `"Administrator" { ... permissions = {...} ... }`.
            app.profiles.push(deriveProfile(ctx, s));
            continue;
        }
        if (level === 'document' && s.kind === 'block' && ws.length === 1 && prop(props(ctx, inner), 'content') !== undefined) {
            // Shape C print-template / record-summary file: `Name { displayname = ... content = {...} }`.
            app.configuration.push(propertyBlock(ctx, s, 'template'));
            continue;
        }
        if (level === 'document' && s.kind === 'group' && top1(s) === '{') {
            // A JSON settings file (e.g. translation settings).
            app.translations.push(translation(ctx, s));
            continue;
        }
        if (level === 'document' && s.kind === 'block' && lw.includes('as')) {
            // Shape C: a workflow or function definition file starts at `Name as "Label" { ... }`.
            const ps = props(ctx, inner);
            const type = prop(ps, 'type')?.toLowerCase();
            if (type === 'functions')
                deriveCreatorFunction(ctx, s);
            else
                deriveWorkflowDef(ctx, s, undefined);
            continue;
        }
        if (kw === 'share_settings' && s.kind === 'block' && ws.length === 1) {
            deriveShareSettings(ctx, s);
            continue;
        }
        if (kw === 'roles' && s.kind === 'block' && ws.length === 1) {
            claim(ctx, s, 'roles');
            for (const c of inner)
                if (c.kind === 'block')
                    app.roles.push(deriveRole(ctx, c));
            continue;
        }
        if (kw === 'translation' && s.kind === 'block' && ws.length === 1) {
            claim(ctx, s, 'translation');
            for (const c of inner)
                if (c.kind === 'group')
                    app.translations.push(translation(ctx, c));
            continue;
        }
        if ((CONFIG_BLOCKS.has(kw) || CONFIG_BLOCKS.has(lw.join(' '))) && (s.kind === 'block' || s.kind === 'call')) {
            app.configuration.push(propertyBlock(ctx, s, 'configuration'));
            visitOpaque(ctx, inner, ws[ws.length - 1]);
            continue;
        }
        if (kw === 'api' && s.kind === 'block' && ws.length === 2) {
            const api = propertyBlock(ctx, s, 'api');
            api.name = ws[1];
            app.apis.push(api);
            continue;
        }
        if ((KNOWN_OPAQUE.has(kw) || KNOWN_OPAQUE.has(lw.join(' '))) && (s.kind === 'block' || s.kind === 'call')) {
            // Known blocks whose content is preserved in the CST but not modelled.
            app.unmodelled.push({ context: level, keyword: safeHeader(lw), span: span(ctx, s) });
            if (ws.length === 1 || PROFILE_LIKE.has(kw))
                visitOpaque(ctx, inner, ws[ws.length - 1]);
            continue;
        }
        if (level === 'container') {
            app.unmodelled.push({ context: level, keyword: safeHeader(lw), span: span(ctx, s) });
            visitOpaque(ctx, inner, ws[ws.length - 1]);
            continue;
        }
        unknown(ctx, level, s);
    }
}
/** Keyword of an unmodelled block, without the identifiers that follow it. */
function safeHeader(lw) {
    const out = [];
    for (const w of lw) {
        if (!/^[a-z]+$/.test(w))
            break;
        out.push(w);
    }
    return out.join(' ') || '<name>';
}
/** Blocks that are recognised but whose content is preserved, not modelled. */
const KNOWN_OPAQUE = new Set(['share', 'profiles', 'profile', 'role', 'portal', 'users', 'permissions', 'devices', 'web', 'phone', 'tablet', 'api']);
const PROFILE_LIKE = new Set(['profile', 'role', 'portal']);
/** Walk an unmodelled block only to collect `permissions = {...}` properties. */
function visitOpaque(ctx, stmts, owner) {
    for (const s of stmts) {
        collectPermissions(ctx, s, owner);
        if (s.kind === 'block' || s.kind === 'call') {
            const ws = words(s);
            visitOpaque(ctx, body(s), ws.length ? unquote(ws[ws.length - 1]) : owner);
        }
    }
}
function collectPermissions(ctx, s, owner) {
    if (s.kind !== 'property')
        return;
    const p = property(ctx, s);
    if (p.key.toLowerCase() === 'permissions') {
        ctx.app.permissions.push({ owner, value: p.value, span: p.span });
        claim(ctx, s, 'permission');
    }
}
function showFromOf(s) {
    const lw = lower(words(s));
    const i = lw.indexOf('from');
    if (i >= 2 && lw[i - 1] === 'rows' && lw[i - 2] === 'all')
        return words(s)[i + 1];
    return undefined;
}
function showFrom(stmts) {
    for (const s of stmts) {
        const f = showFromOf(s);
        if (f !== undefined)
            return f;
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// pages, translations
function page(ctx, name, content, ps, s, sectionName) {
    const zml = content !== undefined ? parseZml(content) : [];
    return {
        name,
        displayName: prop(ps, 'displayname'),
        section: sectionName,
        content,
        zml,
        references: zmlReferences(zml),
        properties: ps,
        span: span(ctx, s),
    };
}
function translation(ctx, s) {
    claim(ctx, s, 'translation');
    const json = text(ctx, s);
    const t = { json, span: span(ctx, s) };
    try {
        t.data = JSON.parse(json);
    }
    catch {
        // kept verbatim
    }
    return t;
}
// ---------------------------------------------------------------------------
// forms
function field(ctx, s, name, modifiers, role) {
    claim(ctx, s, role);
    const inner = body(s);
    const ps = props(ctx, inner, 'field.property');
    const f = {
        name,
        type: prop(ps, 'type'),
        displayName: prop(ps, 'displayname'),
        modifiers,
        required: modifiers.join(' ').includes('must have'),
        unique: modifiers.includes('unique'),
        properties: ps,
        subfields: [],
        annotations: [],
        flags: flags(ctx, inner, 'field.flag'),
        span: span(ctx, s),
    };
    const values = ps.find((p) => p.key.toLowerCase() === 'values')?.value;
    if (values !== undefined) {
        if (values.startsWith('{'))
            f.choices = stringList(values);
        else {
            const lookup = /^([\p{L}_][\p{L}\p{N}_]*)(?:\[([^\]]+)\])?\.([\p{L}_][\p{L}\p{N}_]*)$/u.exec(values);
            if (lookup) {
                const fmt = prop(ps, 'displayformat');
                f.lookup = {
                    form: lookup[1],
                    field: lookup[3],
                    ...(lookup[2] !== undefined ? { criteria: lookup[2] } : {}),
                    ...(fmt !== undefined ? { displayFormat: fmt } : {}),
                };
            }
        }
    }
    const init = ps.find((p) => p.key.toLowerCase() === 'initial value')?.value;
    if (init !== undefined)
        f.initialValue = init;
    for (const c of inner) {
        if (c.kind === 'call' && words(c).length >= 1) {
            const cw = words(c);
            f.subfields.push(field(ctx, c, cw[cw.length - 1], lower(cw.slice(0, -1)), 'field.subfield'));
        }
        else if (c.kind === 'group' && top1(c) === '[') {
            f.annotations.push(propertyBlock(ctx, c, 'field.annotation'));
        }
    }
    return f;
}
/** Strings of a `{"a","b"}` literal, decoded. Unquoted items are kept as written. */
function stringList(v) {
    const out = [];
    for (const m of v.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^,\s][^,]*)/g)) {
        if (m[1] !== undefined)
            out.push(unquote(`"${m[1]}"`));
        else if (m[2] !== undefined)
            out.push(unquote(`'${m[2]}'`));
        else
            out.push(m[3].trim());
    }
    return out;
}
function deriveForm(ctx, s, sectionName) {
    const ws = words(s);
    const inner = body(s);
    const ps = props(ctx, inner, 'form.property');
    const form = {
        name: ws[ws.length - 1],
        displayName: prop(ps, 'displayname'),
        section: sectionName,
        properties: ps,
        fields: [],
        actions: [],
        blocks: [],
        span: span(ctx, s),
    };
    for (const c of inner) {
        ctx.app.statementCount++;
        if (c.kind === 'property' || c.kind === 'word')
            continue;
        const cw = words(c);
        const lc = lower(cw);
        const isFormBlock = (FORM_BLOCKS.has(lc[0]) || FORM_BLOCKS.has(lc.join(' '))) &&
            (c.kind === 'block' || (c.kind === 'call' && cw.length === 1 && prop(props(ctx, body(c)), 'type') === undefined));
        if (isFormBlock) {
            form.blocks.push(propertyBlock(ctx, c, 'form.block'));
            continue;
        }
        if (c.kind === 'call' && cw.length >= 1) {
            form.fields.push(field(ctx, c, cw[cw.length - 1], lc.slice(0, -1), 'form.field'));
            continue;
        }
        if (c.kind === 'block' && lc[0] === 'field' && cw.length === 2) {
            // Hand-written variant: `field Name { type = text; ... }`.
            form.fields.push(field(ctx, c, cw[1], [], 'form.field'));
            continue;
        }
        if (c.kind === 'block' && lc[0] === 'actions' && cw.length === 1) {
            claim(ctx, c, 'form.actions');
            const loose = [];
            for (const ev of body(c)) {
                ctx.app.statementCount++;
                if (ev.kind === 'call') {
                    // Buttons declared directly under `actions`, without an `on add` / `on edit` wrapper.
                    loose.push(button(ctx, ev));
                    continue;
                }
                if (ev.kind !== 'block') {
                    if (ev.kind !== 'word' && ev.kind !== 'property')
                        unknown(ctx, 'form', ev);
                    continue;
                }
                const buttons = [];
                for (const b of body(ev))
                    if (words(b).length)
                        buttons.push(button(ctx, b));
                form.actions.push({ event: words(ev).join(' '), buttons, span: span(ctx, ev) });
                claim(ctx, ev, 'form.action');
            }
            if (loose.length)
                form.actions.push({ event: '', buttons: loose, span: span(ctx, c) });
            continue;
        }
        unknown(ctx, 'form', c);
    }
    return form;
}
function button(ctx, b) {
    const bw = words(b);
    const bps = b.kind === 'call' ? props(ctx, body(b), 'form.button.property') : [];
    claim(ctx, b, 'form.button');
    return { name: bw[bw.length - 1], type: prop(bps, 'type'), displayName: prop(bps, 'displayname'), properties: bps };
}
// ---------------------------------------------------------------------------
// reports
function deriveReport(ctx, s, name, type, modifiers, sectionName) {
    claim(ctx, s, 'report');
    const inner = body(s);
    const ps = props(ctx, inner, 'report.property');
    const r = {
        name,
        type,
        modifiers,
        displayName: prop(ps, 'displayname'),
        form: showFrom(inner),
        section: sectionName,
        properties: ps,
        columns: [],
        customActions: [],
        conditionalFormats: [],
        filters: [],
        groupBy: [],
        sortBy: [],
        blocks: [],
        views: [],
        flags: [],
        span: span(ctx, s),
    };
    for (const c of inner) {
        if (c.kind === 'word') {
            const lc = lower(words(c));
            if (lc[0] === 'based' && lc[1] === 'on' && lc.length === 3) {
                claim(ctx, c, 'report.based on');
                r.basedOn = words(c)[2];
            }
            else if (showFromOf(c) === undefined)
                r.flags.push(...flags(ctx, [c], 'report.flag'));
            else
                claim(ctx, c, 'report.source');
            continue;
        }
        if (c.kind !== 'block' && c.kind !== 'call')
            continue;
        const lc = lower(words(c));
        const head = lc.join(' ');
        if (showFromOf(c) !== undefined) {
            claim(ctx, c, 'report.source');
            const crit = sig(c).find((x) => isGroup(x) && x.open.text === '[');
            if (crit)
                r.criteria = inside(ctx, crit).trim();
            const cols = sig(c).some((x) => isGroup(x) && x.structured) ? body(c) : [];
            for (const col of cols) {
                const cw = words(col);
                if (col.kind === 'call' && lower(cw.slice(0, 2)).join(' ') === 'custom action') {
                    r.customActions.push(customAction(ctx, col, unquote(cw.slice(2).join(' ')), true));
                }
                else if (col.kind === 'word' || (col.kind === 'call' && cw.length >= 1)) {
                    r.columns.push(column(ctx, col));
                }
            }
            continue;
        }
        if (head === 'quickview' || head === 'detailview') {
            r.views.push(reportView(ctx, c, head));
            continue;
        }
        if (head === 'custom actions') {
            claim(ctx, c, 'report.custom actions');
            for (const a of body(c))
                if (a.kind === 'call' && words(a).length)
                    r.customActions.push(customAction(ctx, a, unquote(words(a).join(' ')), false));
            continue;
        }
        if (head === 'conditional formatting') {
            claim(ctx, c, 'report.conditional formatting');
            for (const f of body(c)) {
                if (f.kind !== 'block' && f.kind !== 'call')
                    continue;
                claim(ctx, f, 'report.conditional format');
                const fps = props(ctx, body(f), 'report.conditional format.property');
                r.conditionalFormats.push({
                    name: unquote(words(f).join(' ')),
                    condition: fps.find((p) => p.key.toLowerCase() === 'condition')?.value,
                    fields: fps.find((p) => p.key.toLowerCase() === 'fields')?.value,
                    format: prop(fps, 'format'),
                    properties: fps,
                    span: span(ctx, f),
                });
            }
            continue;
        }
        if (head === 'filters') {
            claim(ctx, c, 'report.filters');
            for (const f of body(c)) {
                if (f.kind === 'word') {
                    claim(ctx, f, 'report.filter');
                    r.filters.push({ field: words(f).join(' '), span: span(ctx, f) });
                }
                else if (f.kind === 'pairs') {
                    claim(ctx, f, 'report.filter');
                    const items = sig(f);
                    const colon = items.findIndex((x) => isToken(x) && x.text === ':');
                    const rest = items.slice(colon + 1);
                    r.filters.push({
                        label: unquote(words(f).join(' ')),
                        criteria: rest.length ? ctx.src.slice(nodeStartOf(rest[0]), nodeEndOf(rest[rest.length - 1])) : '',
                        span: span(ctx, f),
                    });
                }
            }
            continue;
        }
        if (head === 'group by' || head === 'sort by') {
            claim(ctx, c, `report.${head}`);
            const list = head === 'group by' ? r.groupBy : r.sortBy;
            for (const g of body(c)) {
                if (g.kind === 'word') {
                    claim(ctx, g, `report.${head}.field`);
                    const gw = words(g);
                    const last = gw[gw.length - 1]?.toLowerCase();
                    if (gw.length > 1 && (last === 'ascending' || last === 'descending'))
                        list.push({ field: gw.slice(0, -1).join(' '), order: last });
                    else
                        list.push({ field: gw.join(' ') });
                }
                else if (isBody(g))
                    r.blocks.push(propertyBlock(ctx, g, 'report.block'));
            }
            continue;
        }
        if (REPORT_BLOCKS.has(head)) {
            r.blocks.push(propertyBlock(ctx, c, 'report.block'));
            continue;
        }
    }
    return r;
}
function column(ctx, s) {
    claim(ctx, s, 'report.column');
    const { name, label } = nameAndLabel(words(s));
    const inner = s.kind === 'call' ? body(s) : [];
    const ps = props(ctx, inner, 'report.column.property');
    const subcolumns = inner.filter((c) => c.kind === 'word' || (c.kind === 'call' && words(c).length)).map((c) => column(ctx, c));
    return { field: name, ...(label !== undefined ? { label } : {}), properties: ps, subcolumns, span: span(ctx, s) };
}
function customAction(ctx, s, name, isColumn) {
    claim(ctx, s, 'report.custom action');
    const inner = body(s);
    const ps = props(ctx, inner, 'report.custom action.property');
    return {
        name,
        workflow: prop(ps, 'workflow'),
        column: isColumn,
        properties: ps,
        flags: flags(ctx, inner, 'report.custom action.flag'),
        blocks: inner.filter((c) => isBody(c)).map((c) => propertyBlock(ctx, c, 'report.custom action.block')),
        span: span(ctx, s),
    };
}
function reportView(ctx, s, kind) {
    claim(ctx, s, `report.${kind}`);
    const inner = body(s);
    const v = {
        kind: kind,
        ...(ctx.device ? { device: ctx.device } : {}),
        layoutProperties: [],
        blocks: [],
        menus: {},
        actions: {},
        properties: props(ctx, inner, 'report.view.property'),
        span: span(ctx, s),
    };
    for (const c of inner) {
        if (!isBody(c))
            continue;
        const head = lower(words(c)).join(' ');
        if (head === 'layout') {
            claim(ctx, c, 'report.view.layout');
            v.layoutProperties = props(ctx, body(c), 'report.view.layout.property');
            v.layoutType = prop(v.layoutProperties, 'type');
            for (const b of body(c)) {
                if (!isBody(b))
                    continue;
                claim(ctx, b, 'report.view.block');
                const bps = props(ctx, body(b), 'report.view.block.property');
                const blk = {
                    name: words(b).map(unquote).join(' '),
                    title: prop(bps, 'title'),
                    layoutType: prop(bps, 'layout type'),
                    relatedField: prop(bps, 'related field'),
                    fields: [],
                    properties: bps,
                    span: span(ctx, b),
                };
                for (const f of body(b)) {
                    if (lower(words(f)).join(' ') !== 'fields' || !isBody(f))
                        continue;
                    claim(ctx, f, 'report.view.fields');
                    for (const col of body(f))
                        if (col.kind === 'word' || col.kind === 'call')
                            blk.fields.push(column(ctx, col));
                }
                v.blocks.push(blk);
            }
        }
        else if (head === 'menu') {
            claim(ctx, c, 'report.view.menu');
            for (const m of body(c))
                if (isBody(m)) {
                    claim(ctx, m, 'report.view.menu');
                    v.menus[lower(words(m)).join(' ')] = itemList(ctx, m, 'report.view.item');
                }
        }
        else if (head === 'action') {
            claim(ctx, c, 'report.view.action');
            for (const a of body(c))
                if (isBody(a) || a.children.some((x) => isGroup(x) && x.raw)) {
                    claim(ctx, a, 'report.view.action');
                    v.actions[lower(words(a)).join(' ')] = itemList(ctx, a, 'report.view.item');
                }
        }
    }
    return v;
}
// ---------------------------------------------------------------------------
// devices
function device(ctx, name, s) {
    let d = ctx.app.devices.find((x) => x.device === name);
    if (!d) {
        d = { device: name, sections: [], unused: [], forms: [], components: [], span: span(ctx, s) };
        ctx.app.devices.push(d);
    }
    return d;
}
function deriveDevice(ctx, s, name) {
    claim(ctx, s, 'device');
    const saved = ctx.device;
    ctx.device = name;
    deriveDeviceBody(ctx, device(ctx, name, s), body(s));
    ctx.device = saved;
}
function deriveDeviceBody(ctx, d, stmts, space) {
    for (const c of stmts) {
        const cw = words(c);
        const lc = lower(cw);
        const head = lc.join(' ');
        if (!isBody(c))
            continue;
        if (head === 'customize')
            d.customize = propertyBlock(ctx, c, 'device.customize');
        else if (head === 'forms') {
            claim(ctx, c, 'device.forms');
            for (const f of body(c))
                if (f.kind === 'block' && lower(words(f))[0] === 'form' && words(f).length === 2) {
                    claim(ctx, f, 'device.form');
                    d.forms.push({ name: words(f)[1], properties: props(ctx, body(f), 'device.form.property'), span: span(ctx, f) });
                }
        }
        else if (head === 'reports') {
            claim(ctx, c, 'device.reports');
            for (const r of body(c))
                if (isBody(r) && words(r).length >= 2)
                    d.components.push(deviceComponent(ctx, r));
        }
        else if (head === 'menu') {
            claim(ctx, c, 'device.menu');
            deriveDeviceBody(ctx, d, body(c));
        }
        else if (head === 'preference' && cw.length === 1)
            d.menuPreference = propertyBlock(ctx, c, 'device.menu preference');
        else if (head === 'unused' && cw.length === 1) {
            claim(ctx, c, 'device.unused');
            d.unused.push(...menuEntries(ctx, body(c)));
        }
        else if (lc[0] === 'space' && cw.length === 2) {
            claim(ctx, c, 'device.space');
            props(ctx, body(c), 'device.space.property');
            deriveDeviceBody(ctx, d, body(c), cw[1]);
            // components placed directly in a space, outside any section
            const direct = menuEntries(ctx, body(c).filter((e) => lower(words(e))[0] !== 'section'));
            if (direct.length)
                d.sections.push({ name: '', space: cw[1], properties: [], components: direct, span: span(ctx, c) });
        }
        else if (lc[0] === 'section' && cw.length === 2) {
            claim(ctx, c, 'device.section');
            const sec = { name: cw[1], ...(space ? { space } : {}), properties: props(ctx, body(c), 'device.section.property'), components: [], span: span(ctx, c) };
            sec.components.push(...menuEntries(ctx, body(c)));
            d.sections.push(sec);
        }
    }
}
/** Component entries of a device menu body; `systemcomponent { type = ... }` entries are named by their type. */
function menuEntries(ctx, stmts) {
    const out = [];
    for (const e of stmts) {
        if (isBody(e) && words(e).length >= 2)
            out.push(deviceComponent(ctx, e));
        else if (e.kind === 'block' && lower(words(e)).join(' ') === 'systemcomponent') {
            const comp = deviceComponent(ctx, e);
            comp.kind = 'systemcomponent';
            comp.name = prop(comp.properties, 'type') ?? '';
            out.push(comp);
        }
    }
    return out;
}
function deviceComponent(ctx, s) {
    claim(ctx, s, 'device.component');
    const ws = words(s);
    const inner = body(s);
    const views = [];
    for (const c of inner) {
        const head = lower(words(c)).join(' ');
        if ((head === 'quickview' || head === 'detailview') && isBody(c))
            views.push(reportView(ctx, c, head));
    }
    return {
        kind: lower(ws.slice(0, -1)).join(' '),
        name: ws[ws.length - 1],
        properties: props(ctx, inner, 'device.component.property'),
        views,
        span: span(ctx, s),
    };
}
/**
 * Attach device report views to the reports they belong to. Views whose report
 * is not in this IR stay on the device component.
 */
export function linkDeviceViews(app) {
    for (const d of app.devices) {
        for (const comp of [...d.components, ...d.unused, ...d.sections.flatMap((s) => s.components)]) {
            if (!comp.views.length)
                continue;
            const r = app.reports.find((x) => x.name === comp.name);
            if (!r)
                continue;
            for (const v of comp.views)
                r.views.push({ ...v, device: d.device });
            comp.views = [];
        }
        d.components = d.components.filter((c) => c.views.length || c.properties.length);
    }
}
// ---------------------------------------------------------------------------
// share settings: profiles and roles
function deriveShareSettings(ctx, s) {
    claim(ctx, s, 'share settings');
    for (const c of body(s)) {
        const cw = words(c);
        if (c.kind === 'property') {
            if (property(ctx, c).key.toLowerCase() === 'permissions')
                continue;
            ctx.app.shareSettings.push(property(ctx, c));
            claim(ctx, c, 'share settings.property');
        }
        else if (c.kind === 'block' && cw.length === 1 && cw[0].toLowerCase() === 'roles') {
            claim(ctx, c, 'roles');
            for (const r of body(c))
                if (r.kind === 'block')
                    ctx.app.roles.push(deriveRole(ctx, r));
        }
        else if (c.kind === 'block' && cw.length >= 1) {
            ctx.app.profiles.push(deriveProfile(ctx, c));
        }
    }
}
function deriveProfile(ctx, s) {
    claim(ctx, s, 'profile');
    const name = unquote(words(s).join(' '));
    const inner = body(s);
    const ps = props(ctx, inner, 'profile.property');
    for (const c of inner)
        collectPermissions(ctx, c, name);
    const p = {
        name,
        type: prop(ps, 'type'),
        description: prop(ps, 'description'),
        permissions: ps.find((x) => x.key.toLowerCase() === 'permissions')?.value,
        properties: ps,
        modules: [],
        span: span(ctx, s),
    };
    for (const c of inner) {
        if (c.kind !== 'block' || lower(words(c)).join(' ') !== 'modulepermissions')
            continue;
        claim(ctx, c, 'profile.modules');
        for (const m of body(c)) {
            if (m.kind !== 'block' || !words(m).length)
                continue;
            claim(ctx, m, 'profile.module');
            const mi = body(m);
            const mod = {
                component: unquote(words(m).join(' ')),
                properties: props(ctx, mi, 'profile.module.property'),
                reports: [],
                fields: [],
                span: span(ctx, m),
            };
            for (const b of mi) {
                const head = lower(words(b)).join(' ');
                if (b.kind === 'block' && head === 'reportpermissions') {
                    claim(ctx, b, 'profile.module.reports');
                    mod.reports.push(...props(ctx, body(b), 'profile.module.report'));
                }
                else if (b.kind === 'block' && head === 'fieldpermissions') {
                    claim(ctx, b, 'profile.module.fields');
                    for (const f of body(b)) {
                        if (f.kind !== 'block' || !words(f).length)
                            continue;
                        claim(ctx, f, 'profile.module.field');
                        const flags = {};
                        for (const pr of body(f)) {
                            if (pr.kind !== 'pairs')
                                continue;
                            claim(ctx, pr, 'profile.module.field');
                            for (const [k, v] of pairs(pr))
                                flags[k] = v;
                        }
                        mod.fields.push({ field: words(f).join(' '), flags, span: span(ctx, f) });
                    }
                }
            }
            p.modules.push(mod);
        }
    }
    return p;
}
/** `a:true,b:false` → [[a,true],[b,false]]. */
function pairs(s) {
    const out = [];
    let key = [];
    let val = [];
    let inVal = false;
    for (const t of sig(s)) {
        if (!isToken(t)) {
            (inVal ? val : key).push('…');
            continue;
        }
        if (t.text === ':' && !inVal)
            inVal = true;
        else if (t.text === ',' || t.text === ';') {
            if (key.length)
                out.push([key.join(' '), val.join('')]);
            key = [];
            val = [];
            inVal = false;
        }
        else
            (inVal ? val : key).push(t.text);
    }
    if (key.length)
        out.push([key.join(' '), val.join('')]);
    return out;
}
function deriveRole(ctx, s) {
    claim(ctx, s, 'role');
    const inner = body(s);
    const ps = props(ctx, inner, 'role.property');
    return {
        name: unquote(words(s).join(' ')),
        description: prop(ps, 'description'),
        properties: ps,
        children: inner.filter((c) => c.kind === 'block' && words(c).length).map((c) => deriveRole(ctx, c)),
        span: span(ctx, s),
    };
}
// ---------------------------------------------------------------------------
// workflows and functions
function deriveWorkflowContainer(ctx, s, container) {
    claim(ctx, s, 'workflow.container');
    for (const c of body(s)) {
        ctx.app.statementCount++;
        if (c.kind === 'block' && words(c).length >= 1)
            deriveWorkflowDef(ctx, c, container);
        else if (c.kind !== 'property' && c.kind !== 'word')
            unknown(ctx, 'workflow', c);
    }
}
function deriveWorkflowDef(ctx, s, container) {
    const { name, label } = nameAndLabel(words(s));
    const inner = body(s);
    const ps = props(ctx, inner, 'workflow.property');
    const type = prop(ps, 'type');
    claim(ctx, s, 'workflow.definition');
    const base = {
        name,
        label,
        container: container ?? type,
        type,
        form: prop(ps, 'form'),
        recordEvent: prop(ps, 'record event'),
        properties: ps,
    };
    for (const c of inner) {
        const head = lower(words(c)).join(' ');
        if (c.kind === 'block' && head === 'field rules') {
            claim(ctx, c, 'workflow.field rules');
            base.fieldRules = (base.fieldRules ?? []).concat(fieldRules(ctx, c));
        }
        else if (c.kind === 'block' && head === 'start') {
            // blueprint `start { start stage = S }`
            base.blueprint ??= { stages: [], transitions: [] };
            base.blueprint.start = propertyBlock(ctx, c, 'workflow.blueprint.start');
        }
        else if (c.kind === 'block' && (head === 'stages' || head === 'transitions')) {
            base.blueprint ??= { stages: [], transitions: [] };
            claim(ctx, c, `workflow.blueprint`);
            for (const t of body(c)) {
                if (!isBody(t))
                    continue;
                if (head === 'stages')
                    base.blueprint.stages.push(propertyBlock(ctx, t, 'workflow.blueprint.stage'));
                else
                    base.blueprint.transitions.push(transition(ctx, t));
            }
        }
    }
    const events = inner.filter((c) => c.kind === 'block' && EVENT_RE.test(words(c)[0]?.toLowerCase() ?? ''));
    if (events.length === 0) {
        for (const c of inner)
            claimDeluge(ctx, c);
        const raw = firstRaw(inner);
        ctx.app.workflows.push({ ...base, event: '', deluge: raw ? rawDeluge(ctx, raw) : null, span: span(ctx, s) });
        return;
    }
    for (const ev of events)
        workflowEvents(ctx, ev, base, '');
}
/** One workflow entry per handler; approval levels nest `on approve` / `on reject` inside `on level N`. */
function workflowEvents(ctx, ev, base, prefix) {
    claim(ctx, ev, 'workflow.event');
    const event = prefix + words(ev).join(' ');
    const inner = body(ev);
    const nested = inner.filter((c) => c.kind === 'block' && EVENT_RE.test(words(c)[0]?.toLowerCase() ?? ''));
    if (nested.length) {
        const approvers = inner.filter((c) => c.kind === 'call' && lower(words(c)).join(' ') === 'approvers');
        const level = { ...base };
        for (const a of approvers) {
            claim(ctx, a, 'workflow.approvers');
            level.approvers = [...(level.approvers ?? []), ...props(ctx, body(a), 'workflow.approvers.property')];
        }
        for (const n of nested)
            workflowEvents(ctx, n, level, `${event} / `);
        return;
    }
    // `on add { actions { on validate ( ... ) on success ( ... ) } }`: one entry per handler.
    const hs = handlers(inner);
    for (const c of inner)
        if (c.kind === 'block' && lower(words(c)).join(' ') === 'actions' && body(c).length === 0)
            claim(ctx, c, 'workflow.actions');
    if (hs.length) {
        const recordLevel = RECORD_EVENTS.has(event.toLowerCase());
        const rec = recordLevel ? { recordEvent: base.recordEvent ?? event } : {};
        for (const h of hs) {
            for (const a of h.path)
                claim(ctx, a, 'workflow.actions');
            if (!h.stmt) {
                // A run inside `actions { ... }` mixes field rules (`hide A, B.C;`),
                // button declarations (`Save ( type = submit ... )`) and free Deluge.
                // Field rules apply at the event's form context: under a record event
                // that context is its load screen.
                const criteria = actionCriteria(ctx, h.path);
                const fieldStmts = [];
                const delugeStmts = [];
                for (const c of h.run) {
                    if (fieldRuleVerb(c))
                        fieldStmts.push(c);
                    else if (recordLevel && c.kind === 'call' && workflowButton(ctx, c, base.form, event))
                        continue;
                    else
                        delugeStmts.push(c);
                }
                if (fieldStmts.length) {
                    const actions = [];
                    for (const c of fieldStmts) {
                        claim(ctx, c, 'workflow.field rule.action');
                        const toks = sig(c).filter((x) => isToken(x) && x.kind !== 'punct');
                        if (toks.length)
                            actions.push({ action: toks[0].text, fields: fieldNames(c) });
                    }
                    if (actions.length) {
                        const first = fieldStmts[0];
                        const last = fieldStmts[fieldStmts.length - 1];
                        const ruleSpan = span(ctx, { start: first.start, end: last.end });
                        ctx.app.workflows.push({
                            ...base,
                            ...rec,
                            ...criteria,
                            event: recordLevel ? 'on load' : event,
                            deluge: null,
                            fieldRules: [
                                {
                                    ...(criteria.actionCondition ? { condition: criteria.actionCondition } : {}),
                                    actions,
                                    span: ruleSpan,
                                },
                            ],
                            span: ruleSpan,
                        });
                    }
                }
                if (delugeStmts.length) {
                    // Statements written directly in `actions { ... }` run on the event itself.
                    for (const c of delugeStmts)
                        claimAll(ctx, c, 'deluge');
                    const first = delugeStmts[0];
                    const last = delugeStmts[delugeStmts.length - 1];
                    const d = {
                        text: delugeStmts.map((c) => ctx.src.slice(c.start, c.end)).join('\n'),
                        span: span(ctx, { start: first.start, end: last.end }),
                    };
                    ctx.app.workflows.push({ ...base, ...rec, ...criteria, event, deluge: d, span: d.span });
                }
                continue;
            }
            claim(ctx, h.stmt, 'workflow.handler');
            if (!h.raw.raw)
                for (const c of children(h.stmt))
                    claimAll(ctx, c, 'deluge');
            const name = words(h.stmt).join(' ');
            // `custom deluge script ( ... )` is a plain wrapper: the Deluge runs on the event itself.
            const wrapper = name.toLowerCase() === 'custom deluge script';
            const e = wrapper || name.toLowerCase() === event.toLowerCase() ? event : recordLevel ? name : `${event} / ${name}`;
            ctx.app.workflows.push({ ...base, ...(wrapper ? {} : rec), ...actionCriteria(ctx, h.path), event: e, deluge: rawDeluge(ctx, h.raw), span: span(ctx, h.stmt) });
        }
        return;
    }
    // An actions brace kept raw still holds Deluge (`on start { actions { openUrl(...); } }`).
    // An actions brace with neither statements nor a raw group is empty.
    // An event whose own brace is raw has no structured statements; sectionDeluge reads that body.
    const onlyEmptyActions = inner.length > 0 &&
        inner.every((c) => c.kind === 'block' && lower(words(c)).join(' ') === 'actions' && body(c).length === 0 && allRaw(c.children).length === 0);
    const deluge = onlyEmptyActions ? [] : sectionDeluge(ctx, ev);
    if (deluge.length <= 1)
        ctx.app.workflows.push({ ...base, event, deluge: deluge[0] ?? null, span: span(ctx, ev) });
    else
        for (const d of deluge)
            ctx.app.workflows.push({ ...base, event, deluge: d, span: span(ctx, ev) });
}
const RECORD_EVENTS = new Set(['on add', 'on edit', 'on add or edit', 'on delete']);
/**
 * `on X ( <deluge> )` handlers, directly or inside `actions { ... }` blocks, and
 * runs of other statements written directly inside `actions`, in source order.
 */
/** Innermost `actions (criteria)` on the path. A block with no criteria does not hide an outer one. */
function actionCriteria(ctx, path) {
    for (let i = path.length - 1; i >= 0; i--) {
        const block = path[i];
        if (!block || block.kind !== 'block' || lower(words(block)).join(' ') !== 'actions')
            continue;
        const cond = sig(block).find((item) => isGroup(item) && item.open.text === '(');
        if (!cond || !isGroup(cond))
            continue;
        const text = inside(ctx, cond).trim();
        if (text)
            return { actionCondition: text };
    }
    return {};
}
function handlers(stmts, path = []) {
    const out = [];
    let run = [];
    const flush = () => {
        if (run.length)
            out.push({ run, path });
        run = [];
    };
    for (const c of stmts) {
        const ws = lower(words(c));
        const raw = c.kind === 'call' ? (c.children.find((x) => isGroup(x) && x.raw) ?? bodyGroup(c)) : undefined;
        if (raw && (ws[0] === 'on' || ws.join(' ') === 'custom deluge script')) {
            flush();
            out.push({ stmt: c, raw, path });
        }
        else if (c.kind === 'block' && ws.join(' ') === 'actions') {
            flush();
            out.push(...handlers(body(c), [...path, c]));
        }
        else if (path.length)
            run.push(c);
    }
    flush();
    return out;
}
/** `hide A, B.C;` — the word-statement shape of a field rule inside `actions { }`. */
const FIELD_RULE_VERBS = new Set(['hide', 'show', 'enable', 'disable']);
function fieldRuleVerb(s) {
    if (s.kind !== 'word')
        return false;
    const ws = lower(words(s));
    return ws.length >= 2 && FIELD_RULE_VERBS.has(ws[0]);
}
/**
 * `Name ( type = submit|button|reset|cancel ... )` inside a record-event
 * `actions` block declares a button on the workflow's form for that record
 * event. Merged into `form.actions`, deduplicated by name.
 */
const WORKFLOW_BUTTON_TYPES = new Set(['submit', 'button', 'reset', 'cancel']);
function workflowButton(ctx, s, formName, event) {
    // Peek before claiming: a handler's Deluge body can hold `key = value` lines.
    const head = lower(words(s))[0];
    if (head === 'on' || head === 'custom')
        return false;
    const type = prop(props(ctx, body(s)), 'type');
    if (!type || !WORKFLOW_BUTTON_TYPES.has(type.toLowerCase()))
        return false;
    claim(ctx, s, 'form.button');
    const bps = props(ctx, body(s), 'form.button.property');
    const b = { name: words(s).join(' '), type, displayName: prop(bps, 'displayname'), properties: bps };
    const form = ctx.app.forms.find((f) => f.name === formName);
    if (!form)
        return true;
    let entry = form.actions.find((a) => a.event.toLowerCase() === event.toLowerCase());
    if (!entry) {
        entry = { event, buttons: [], span: span(ctx, s) };
        form.actions.push(entry);
    }
    if (!entry.buttons.some((x) => x.name === b.name))
        entry.buttons.push(b);
    return true;
}
function fieldRules(ctx, s) {
    const out = [];
    for (const a of body(s)) {
        if (a.kind !== 'block' || lower(words(a))[0] !== 'actions')
            continue;
        claim(ctx, a, 'workflow.field rule');
        const cond = sig(a).find((x) => isGroup(x) && x.open.text === '(');
        const rule = { ...(cond ? { condition: inside(ctx, cond).trim() } : {}), actions: [], span: span(ctx, a) };
        for (const w of body(a)) {
            if (w.kind !== 'word')
                continue;
            claim(ctx, w, 'workflow.field rule.action');
            const toks = sig(w).filter((x) => isToken(x) && x.kind !== 'punct');
            if (toks.length)
                rule.actions.push({ action: toks[0].text, fields: fieldNames(w) });
        }
        out.push(rule);
    }
    return out;
}
/** `hide A, B.C;` → [A, B.C] */
function fieldNames(s) {
    const out = [];
    let cur = '';
    const items = sig(s).filter((x) => isToken(x));
    for (let i = 1; i < items.length; i++) {
        const t = items[i];
        if (t.text === ',' || t.text === ';') {
            if (cur)
                out.push(cur);
            cur = '';
        }
        else if (t.text === '.' || cur.endsWith('.'))
            cur += t.text;
        else {
            if (cur)
                out.push(cur);
            cur = t.text;
        }
    }
    if (cur)
        out.push(cur);
    return out;
}
function transition(ctx, s) {
    claim(ctx, s, 'workflow.blueprint.transition');
    const inner = body(s);
    const ps = props(ctx, inner, 'workflow.blueprint.transition.property');
    const t = {
        name: unquote(words(s).join(' ')),
        fromStage: prop(ps, 'from stage'),
        toStage: prop(ps, 'to stage'),
        properties: ps,
        phases: [],
        span: span(ctx, s),
    };
    for (const c of inner) {
        if (c.kind !== 'block' || !words(c).length)
            continue;
        claim(ctx, c, 'workflow.blueprint.phase');
        const pi = body(c);
        // `actions ( <deluge> )` is Deluge even when its text happens to parse as structured statements.
        const isActions = (x) => x.kind === 'call' && lower(words(x)).join(' ') === 'actions';
        const deluge = [];
        for (const x of pi) {
            const g = isActions(x) ? (allRaw(x.children)[0] ?? bodyGroup(x)) : undefined;
            if (g) {
                claim(ctx, x, 'deluge');
                if (!g.raw)
                    for (const y of children(x))
                        claimAll(ctx, y, 'deluge');
                deluge.push(rawDeluge(ctx, g));
            }
            else
                deluge.push(...allRaw(x.children).map((r) => rawDeluge(ctx, r)));
        }
        t.phases.push({
            phase: lower(words(c)).join(' '),
            properties: props(ctx, pi, 'workflow.blueprint.phase.property'),
            blocks: pi.filter((x) => x.kind === 'call' && !isActions(x) && !allRaw(x.children).length && isBody(x)).map((x) => propertyBlock(ctx, x, 'workflow.blueprint.phase.block')),
            deluge,
            span: span(ctx, c),
        });
        for (const x of pi)
            claimDeluge(ctx, x);
    }
    return t;
}
function deriveFunctions(ctx, stmts) {
    for (const c of stmts) {
        ctx.app.statementCount++;
        const ws = words(c);
        if (c.kind !== 'block' || ws.length === 0) {
            if (c.kind !== 'property' && c.kind !== 'word')
                unknown(ctx, 'functions', c);
            continue;
        }
        const items = sig(c);
        const paren = items.find((x) => isGroup(x) && x.open.text === '(');
        const brace = items[items.length - 1];
        if (paren && isGroup(brace) && brace.open.text === '{' && items.indexOf(paren) === items.length - 2) {
            // `void openSummary(Add_Record myRec) { ... }`
            const head = items.slice(0, items.indexOf(paren));
            claimAll(ctx, c, 'function');
            ctx.app.functions.push({
                name: head.slice(1).map((x) => (isToken(x) ? x.text : '')).join(''),
                kind: 'deluge',
                signature: ctx.src.slice(c.start, brace.start).trimEnd(),
                deluge: [rawDeluge(ctx, brace)],
                properties: [],
                span: span(ctx, c),
            });
        }
        else if (lower(ws).includes('as') || prop(props(ctx, body(c)), 'type')) {
            deriveCreatorFunction(ctx, c);
        }
        else {
            // A namespace block grouping deluge functions.
            claim(ctx, c, 'functions.namespace');
            deriveFunctions(ctx, body(c));
        }
    }
}
function deriveCreatorFunction(ctx, s) {
    const { name, label } = nameAndLabel(words(s));
    const inner = body(s);
    const ps = props(ctx, inner, 'function.property');
    claim(ctx, s, 'function');
    const deluge = [];
    for (const c of inner) {
        if (c.kind === 'property')
            continue;
        if (c.kind === 'block' && EVENT_RE.test(words(c)[0]?.toLowerCase() ?? '')) {
            claim(ctx, c, 'function.event');
            deluge.push(...sectionDeluge(ctx, c));
        }
        else if (claimDeluge(ctx, c))
            deluge.push(...allRaw(c.children).map((g) => rawDeluge(ctx, g)));
    }
    ctx.app.functions.push({ name, label, kind: 'creator', form: prop(ps, 'form'), deluge, properties: ps, span: span(ctx, s) });
}
// ---------------------------------------------------------------------------
export function parseHeader(src) {
    const m = /^\s*\/\*([\s\S]*?)\*\//.exec(src);
    if (!m)
        return undefined;
    const h = {};
    for (const line of m[1].split(/\r\n|\n|\r/)) {
        const kv = /^\s*\*?\s*(Author|Generated on|Version)\s*:\s*(.*?)\s*$/i.exec(line);
        if (!kv)
            continue;
        const k = kv[1].toLowerCase();
        if (k === 'author')
            h.author = kv[2];
        else if (k === 'version')
            h.version = kv[2];
        else
            h.generatedOn = kv[2];
    }
    return Object.keys(h).length ? h : undefined;
}
const CREATOR_TOP = new Set([
    'application',
    'form',
    'forms',
    'menu',
    'workflow',
    'functions',
    'page',
    'section',
    'reports',
    'pages',
    'share_settings',
    'roles',
    'translation',
    ...REPORT_TYPES,
    ...KNOWN_OPAQUE,
    ...CONFIG_BLOCKS,
]);
function top1(s) {
    const g = sig(s)[0];
    return g && isGroup(g) ? g.open.text : undefined;
}
/** `ret name(args) { ... }` */
function isSignatureBlock(s) {
    if (s.kind !== 'block')
        return false;
    const items = sig(s);
    return items.length >= 3 && isGroup(items[items.length - 2]) && items[items.length - 2].open.text === '(';
}
/** Recognise the non-`application` files of a multi-file (shape C) export. */
function fragmentKind(top) {
    if (top.every((s) => isSignatureBlock(s)))
        return 'functions';
    if (top.some((s) => s.kind === 'block' && words(s).length === 1 && /^["']/.test(words(s)[0])))
        return 'profiles';
    if (top.every((s) => s.kind === 'property'))
        return 'settings';
    if (top.every((s) => s.kind === 'group' && top1(s) === '{'))
        return 'settings';
    if (top.every((s) => s.kind === 'block' && words(s).length === 1 && body(s).some((c) => c.kind === 'property' && words(c)[0]?.toLowerCase() === 'content')))
        return 'settings';
    const first = sig(top[0])[0];
    if ((isToken(first) && first.text === '<') || (top[0].kind === 'word' && words(top[0])[0] === 'panel'))
        return 'zml';
    return null;
}
export function detectShape(doc, header) {
    const top = doc.children.filter(isStatement);
    if (top.length === 0)
        return 'empty';
    if (top.some((s) => s.kind === 'block' && words(s)[0]?.toLowerCase() === 'application')) {
        const major = Number.parseInt(header?.version ?? '', 10);
        return Number.isFinite(major) && major >= 2 ? 'A' : 'B';
    }
    const creatorish = top.some((s) => {
        if (s.kind !== 'block')
            return false;
        const lw = lower(words(s));
        if (CREATOR_TOP.has(lw[0]) || CREATOR_TOP.has(lw.join(' ')) || (lw[0] === 'default' && REPORT_TYPES.has(lw[1])))
            return true;
        if (!lw.includes('as'))
            return false;
        const type = prop(body(s).filter((c) => c.kind === 'property').map((c) => ({ key: words(c).join(' '), value: '', span: { start: 0, end: 0 } })), 'type');
        return type !== undefined;
    });
    if (creatorish)
        return 'C';
    if (fragmentKind(top))
        return 'C';
    const hasSemicolon = (nodes) => nodes.some((n) => (isToken(n) ? n.kind === 'punct' && n.text === ';' : hasSemicolon(n.children)));
    if (hasSemicolon(doc.children))
        return 'deluge';
    return 'unknown';
}
export function emptyApp(shape) {
    return {
        irVersion: IR_VERSION,
        shape,
        settings: [],
        sections: [],
        forms: [],
        reports: [],
        pages: [],
        workflows: [],
        functions: [],
        permissions: [],
        profiles: [],
        roles: [],
        shareSettings: [],
        translations: [],
        configuration: [],
        apis: [],
        devices: [],
        unknown: [],
        unmodelled: [],
        statementCount: 0,
    };
}
/** Device of a multi-file export path: `.../devices/phone/forms.ds`, `.../reports/R/devices/web.ds`. */
export function deviceOfPath(file) {
    const m = file ? /(?:^|\/)devices\/(web|phone|tablet)(?:\/|\.ds$)/i.exec(file) : null;
    return m ? m[1].toLowerCase() : undefined;
}
/** Derive IR v1 from one parsed `.ds` file. `roles` receives the IR role of every modelled statement. */
export function deriveIr(doc, file, roles = new Map()) {
    const header = parseHeader(doc.source);
    const shape = detectShape(doc, header);
    const app = emptyApp(shape);
    if (header)
        app.header = header;
    const ctx = { app, src: doc.source, file, device: deviceOfPath(file), roles };
    const top = doc.children.filter(isStatement);
    if (shape === 'deluge') {
        // A bare Deluge script (custom function file). Keep it whole.
        const start = top[0].start;
        const end = top[top.length - 1].end;
        app.functions.push({
            name: file ?? '',
            kind: 'script',
            deluge: [{ text: doc.source.slice(start, end), span: span(ctx, { start, end }) }],
            properties: [],
            span: span(ctx, { start, end }),
        });
        app.statementCount = top.length;
        for (const s of top)
            claimAll(ctx, s, 'deluge');
        return app;
    }
    if (shape === 'C' && fragmentKind(top) === 'zml') {
        // A page stored as its own ZML file. Kept whole, like `Content="<zml>..."` in monolithic exports.
        const start = top[0].start;
        const end = top[top.length - 1].end;
        app.pages.push(page(ctx, file ?? '', doc.source.slice(start, end), [], { start, end }));
        app.statementCount = top.length;
        for (const s of top)
            claimAll(ctx, s, 'page.zml');
        return app;
    }
    visit(ctx, top, 'document');
    linkDeviceViews(app);
    app.dialect = detectDialect(doc).dialect;
    normaliseDialect(app);
    return app;
}
/** `Form[criteria]` on a schedule, approval, or blueprint is the record selector. A plain form name has no criteria. */
export function formLink(form) {
    if (!form)
        return { name: '', criteria: null };
    const open = form.indexOf('[');
    if (open <= 0 || form[form.length - 1] !== ']')
        return { name: form, criteria: null };
    const name = form.slice(0, open).trim();
    const criteria = form.slice(open + 1, -1).trim();
    if (!/^[A-Za-z_][\w]*$/.test(name) || !criteria)
        return { name: form, criteria: null };
    return { name, criteria };
}
/** Creator approval process: the container, type, event, or approver list marks it. */
export function isApprovalWorkflow(w) {
    const blob = `${w.container ?? ''} ${w.type ?? ''} ${w.event}`;
    return /\bapproval\b/i.test(blob) || /\bon approve\b|\bon reject\b|\bon level\b/i.test(blob) || !!w.approvers?.length;
}
/** A workflow that declares blueprint stages or transitions. */
export function isBlueprintWorkflow(w) {
    const blueprint = w.blueprint;
    return !!blueprint && !!(blueprint.stages.length || blueprint.transitions.length || blueprint.start);
}
/** Creator payment workflows: the container, type, event, or name marks them. They are stubs, not schedules. */
export function isPaymentWorkflow(w) {
    return /\bpayments?\b/i.test(`${w.container ?? ''} ${w.type ?? ''} ${w.event} ${w.name}`);
}
/** A workflow inside a `schedule` container or with `type = schedule`. */
export function isScheduleWorkflow(w) {
    return /\bschedule\b/i.test(`${w.container ?? ''} ${w.type ?? ''}`);
}
/**
 * The schedule branch of codegen: payment, approval, and blueprint workflows
 * win over the schedule container, so a "Payment Reminder" def is not a
 * schedule at all.
 */
export function isScheduleBranchWorkflow(w) {
    if (isPaymentWorkflow(w))
        return false;
    if (isBlueprintWorkflow(w))
        return false;
    return !isApprovalWorkflow(w) && isScheduleWorkflow(w);
}
/**
 * A form schedule — `form = X[criteria]` on the schedule branch. The generated
 * sweeper Job fires the form's due rows; a custom schedule (no form) is a cron.
 */
export function isFormScheduleWorkflow(w) {
    return isScheduleBranchWorkflow(w) && !!formLink(w.form).name;
}
/** The `start` shape of a form schedule: `[before|after N units from] Field [at "HH:mm:ss"]`. */
export const FORM_SCHEDULE_START_RE = /^(?:(before|after)\s+(\d+)\s+(minutes?|hours?|days?|weeks?|months?|years?)\s+from\s+)?([A-Za-z_]\w*)(?:\s+at\s+"(\d{1,2}):(\d{2})(?::(\d{2}))?")?$/;
/** The repeating `frequency` values a form schedule sweep keeps; none means once. */
export const FORM_SCHEDULE_FREQUENCIES = new Set(['daily', 'weekly', 'monthly', 'yearly']);
/** A `key = value` property of one workflow def (`start`, `frequency`, `time zone`, `end`). */
export function workflowProp(w, key) {
    return w.properties.find((p) => p.key.toLowerCase() === key)?.value?.trim();
}
/**
 * The date/datetime field a form schedule's `start` or `end` names, or null.
 * `Added_Time` and `Modified_Time` are record columns, always present.
 */
export function scheduleAnchorFieldType(app, form, field) {
    if (field === 'Added_Time' || field === 'Modified_Time')
        return 'DateTime';
    const f = app.forms.find((x) => x.name === form)?.fields.find((x) => x.name === field);
    const type = (f?.type ?? '').toLowerCase().replace(/[\s_-]/g, '');
    if (type === 'date')
        return 'Date';
    if (type === 'datetime')
        return 'DateTime';
    return null;
}
/** The schedule's `time zone`, else the app setting; an invalid zone fails closed. */
export function scheduleTimeZone(app, w) {
    const raw = workflowProp(w, 'time zone') ?? app.settings.find((p) => p.key.toLowerCase() === 'time zone')?.value;
    const zone = raw ? unquote(raw).trim() : '';
    if (!zone)
        return null;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return zone;
    }
    catch {
        return null;
    }
}
/**
 * Why the sweeper cannot fire a form schedule, or null when it can. The schema
 * planner and the code emitter share this one check so the checkpoint table is
 * planned exactly when a sweeper is emitted. `criteriaOk` reports whether the
 * `Form[criteria]` selector translated; a caller that cannot compile criteria
 * passes true, so an untranslatable selector can only ever keep the table.
 */
export function formScheduleSweepGap(app, w, criteriaOk) {
    const link = formLink(w.form);
    if (link.criteria && !criteriaOk)
        return 'workflow-action-condition';
    const m = FORM_SCHEDULE_START_RE.exec(workflowProp(w, 'start') ?? '');
    if (!m)
        return 'schedule-start';
    if (!scheduleAnchorFieldType(app, link.name, m[4]))
        return 'schedule-start';
    if (!scheduleTimeZone(app, w))
        return 'schedule-time-zone';
    const frequency = workflowProp(w, 'frequency')?.toLowerCase();
    if (frequency && !FORM_SCHEDULE_FREQUENCIES.has(frequency))
        return 'schedule-frequency';
    const end = workflowProp(w, 'end');
    if (end && (!/^[A-Za-z_]\w*$/.test(end) || !scheduleAnchorFieldType(app, link.name, end)))
        return 'schedule-start';
    return null;
}
/**
 * A field whose value identifies an app user: `type = users`, or a picklist
 * with `module = users` (Creator stores the user's login name there).
 */
export function isUsersField(field) {
    if (field.type?.trim().toLowerCase() === 'users')
        return true;
    return field.properties.some((p) => p.key.toLowerCase() === 'module' && unquote(p.value).trim().toLowerCase() === 'users');
}
/**
 * The Data Store column a state machine keeps its current stage in. `Status`
 * is used unless the form already carries a field of that name.
 */
export function flowStatusColumn(fields) {
    const taken = new Set(fields.map((field) => field.name.toLowerCase()));
    for (const name of ['Status', 'Flow_Status']) {
        if (!taken.has(name.toLowerCase()))
            return name;
    }
    let n = 2;
    while (taken.has(`flow_status_${n}`))
        n++;
    return `Flow_Status_${n}`;
}
