import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decode,
  deriveIr,
  encode,
  isStatement,
  parse,
  parseFile,
  parseHeader,
  parseProject,
  detectShape,
  print,
  roundTrips,
  tokenize,
  walkStatements,
  type App,
  type Statement,
} from '../src/index.js';

const ir = (src: string, file?: string): App => deriveIr(parse(src), file);

function assertRoundTrip(src: string): void {
  assert.equal(print(parse(src)), src);
}

// ---------------------------------------------------------------------------
// lexer

test('lexer: tokens cover every character', () => {
  const src = ' application "A" {\r\n\tdate format = "dd" // c\n/* b */ x=1; \'s\' 200px }';
  const toks = tokenize(src);
  assert.equal(toks.map((t) => t.text).join(''), src);
  let pos = 0;
  for (const t of toks) {
    assert.equal(t.start, pos);
    pos += t.text.length;
  }
  assert.deepEqual(
    toks.filter((t) => t.kind === 'string').map((t) => t.text),
    ['"A"', '"dd"', "'s'"],
  );
  assert.ok(toks.some((t) => t.kind === 'nl' && t.text === '\r\n'));
  assert.ok(toks.some((t) => t.kind === 'lineComment' && t.text === '// c'));
  assert.ok(toks.some((t) => t.kind === 'blockComment' && t.text === '/* b */'));
  assert.ok(toks.some((t) => t.kind === 'number' && t.text === '200px'));
});

test('lexer: escaped quotes stay inside the string', () => {
  const toks = tokenize('Content="<zml width=\\"100%\\">"');
  assert.deepEqual(
    toks.map((t) => t.kind),
    ['ident', 'punct', 'string'],
  );
});

test('lexer: unterminated string or comment becomes a bad token, not a crash', () => {
  for (const src of ['x = "abc', "x = 'abc\ny", 'a /* never closed']) {
    const toks = tokenize(src);
    assert.equal(toks.map((t) => t.text).join(''), src);
    assert.ok(toks.some((t) => t.kind === 'bad'));
  }
});

// ---------------------------------------------------------------------------
// round-trip invariant

test('round-trip: tricky snippets', () => {
  const cases = [
    '',
    '\n',
    '﻿ application "x"\r\n{\r\n}\r\n',
    '}}}((([[[',
    'a = "unterminated',
    '/* header */\n application "A"\n {\n \tdate format = "dd-MMM-yyyy"\n }\n',
    'form F\n{\n\tName ( type = text width = 200px )\n}\n',
    'custom deluge script\n(\n\tif(x == "}") { y = \'(\'; } // )\n)\n',
    'émoji 😀 = "ü" ;; ::',
    'mixed\rline\nendings\r\n',
  ];
  for (const c of cases) assertRoundTrip(c);
});

test('round-trip: random input from a .ds-like alphabet (fuzz)', () => {
  const alphabet = ['{', '}', '(', ')', '[', ']', '"', "'", '\\', '/', '*', '=', ' ', '\t', '\n', '\r', 'a', 'Z', '_', '1', '.', ',', ';', ':', 'é', '<', '>'];
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let i = 0; i < 500; i++) {
    let s = '';
    const len = rnd() % 200;
    for (let k = 0; k < len; k++) s += alphabet[rnd() % alphabet.length];
    assertRoundTrip(s);
  }
});

test('round-trip: bytes that are not valid UTF-8 fall back to latin1 losslessly', () => {
  const bytes = Buffer.from([0x66, 0x6f, 0x72, 0x6d, 0x20, 0xe9, 0xff, 0x0a]);
  const { text, encoding } = decode(bytes);
  assert.equal(encoding, 'latin1');
  assert.ok(encode(print(parse(text)), encoding).equals(bytes));
});

// ---------------------------------------------------------------------------
// statements

function topStatements(src: string): Statement[] {
  return parse(src).children.filter(isStatement);
}

test('statements: multi-word property keys and values', () => {
  const app = ir(' application "A"\n {\n \tdate format = "dd-MMM-yyyy"\n \ttime zone = "Asia/Kolkata"\n \tshare data with peers = true\n }\n');
  assert.equal(app.name, 'A');
  assert.deepEqual(
    app.settings.map((p) => [p.key, p.value]),
    [
      ['date format', '"dd-MMM-yyyy"'],
      ['time zone', '"Asia/Kolkata"'],
      ['share data with peers', 'true'],
    ],
  );
});

test('statements: several properties on one line split at the next key', () => {
  const app = ir('form F\n{\n\tName ( type = text width = 200px )\n\tsubmit (type = submit) reset (type = reset)\n}\n');
  const f = app.forms[0];
  assert.deepEqual(
    f.fields[0].properties.map((p) => [p.key, p.value]),
    [
      ['type', 'text'],
      ['width', '200px'],
    ],
  );
  assert.deepEqual(
    f.fields.map((x) => x.name),
    ['Name', 'submit', 'reset'],
  );
});

test('statements: multi-word values run to the end of the line', () => {
  const app = ir('workflow\n{\n form\n {\n  W as "W"\n  {\n   type = form\n   form = F\n   record event = on add or edit\n  }\n }\n}\n');
  assert.equal(app.workflows[0].recordEvent, 'on add or edit');
});

test('statements: a string value followed by words starts a new statement', () => {
  const app = ir('section S\n{\n pivottable P\n {\n  based on V\n  icon = "pin"\t\tshow all rows from T\n  (\n   A as "a"\n  )\n }\n}\n');
  const r = app.reports[0];
  assert.equal(r.type, 'pivottable');
  assert.equal(r.form, 'T');
  assert.deepEqual(
    r.properties.map((p) => [p.key, p.value]),
    [['icon', '"pin"']],
  );
});

test('statements: header on one line, brace on the next', () => {
  const [s] = topStatements('form Book\n\t\t{\n\t\t}\n');
  assert.equal(s.kind, 'block');
});

// ---------------------------------------------------------------------------
// constructs

const SHAPE_B = `/*
 * Author       : someone
 * Generated on : 04-Jan-2025 15:24:33
 * Version      : 1.0
 */
 application "Lib"
 {
 \tdate format = "dd-MMM-yyyy"
 \tsection Section_1
\t{
\t\tdisplayname= "Dashboard"
\t\tpage DashBoard
\t\t{
\t\t\tdisplayname = "Dashboard"
\t\t\tContent="<zml\\n>\\n\\t<layout width=\\"100%\\"></layout></zml>"
\t\t}
\t}
\tsection Section_2
\t{
\t\tdisplayname= "Books"
\t\tform Book
\t\t{
\t\t\tsuccess message = "Book Added"
\t\t\tBook_ID
\t\t\t(
\t\t\t\ttype = autonumber
\t\t\t\tdisplayname = "Book ID"
\t\t\t\tstart index = 512360
\t\t\t)
\t\t\tunique Isbn_Number
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t\tmust have Title
\t\t\t(
\t\t\t\ttype = text
\t\t\t\t[
\t\t\t\t\ttype = tooltip
\t\t\t\t\tmessage = "The title"
\t\t\t\t]
\t\t\t)
\t\t\tGenre
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tvalues = {"Sci-Fi","Fiction"}
\t\t\t)
\t\t\tactions
\t\t\t{
\t\t\t\ton add
\t\t\t\t{
\t\t\t\t\tsubmit
\t\t\t\t\t(
\t\t\t\t\t\ttype = submit
\t\t\t\t\t\tdisplayname = "Submit"
\t\t\t\t\t)
\t\t\t\t}
\t\t\t\ton edit
\t\t\t\t{
\t\t\t\t\tupdate
\t\t\t\t\t(
\t\t\t\t\t\ttype = submit
\t\t\t\t\t)
\t\t\t\t}
\t\t\t}
\t\t}
\t\tlist Book_Report
\t\t{
\t\t\tdisplayName = "All Books"
\t\t\tshow all rows from Book
\t\t\t(
\t\t\t\tTitle
\t\t\t\tBook_ID as "Book ID"
\t\t\t\tAuthor.Name as "Author"
\t\t\t)
\t\t\tcustom actions
\t\t\t(
\t\t\t\t"Feature"
\t\t\t\t(
\t\t\t\tworkflow = Mark_as_Featured
\t\t\t\t)
\t\t\t)
\t\t}
\t\tdefault kanban Book_by_Genre
\t\t{
\t\t\tshow all rows from Book
\t\t\toptions
\t\t\t(
\t\t\t\tdisplay field = Genre
\t\t\t)
\t\t}
\t}
\t\tworkflow
\t\t{
\t\tform
\t\t{
\t\t\tMembership as "Membership types"
\t\t\t{
\t\t\t\ttype =  form
\t\t\t\tform = Book
\t\t\t\trecord event = on add
\t\t\t\ton user input of Genre
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tif(input.Genre == "}") { alert "x"; }
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\ton validate
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\tcustom deluge script
\t\t\t\t\t\t(
\t\t\t\t\t\t\tcancel submit;
\t\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\tfunctions
\t\t{
\t\t\tOverdue as "Overdue Report"
\t\t\t{
\t\t\t\ttype =  functions
\t\t\t\tform = Book
\t\t\t\texecution type = for each record
\t\t\t\ton start
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\ton click
\t\t\t\t\t(
\t\t\t\t\t\tx = input.Title;
\t\t\t\t\t)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t\t}
\tshare_settings
\t{
\t\t\t"Read"
\t\t\t{
\t\t\t\tname = "Read"
\t\t\t\tpermissions = {Chat:false, ApiAccess:true}
\t\t\t\tModulePermissions
\t\t\t\t{
\t\t\t\t\tBook
\t\t\t\t\t{
\t\t\t\t\t\tTitle{visibility:true,readonly:false}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t}
\tshare data with peers = true
\tmystery block
\t{
\t\tanything = 1
\t}
 }
`;

test('shape B: header, application, sections and settings', () => {
  assertRoundTrip(SHAPE_B);
  const app = ir(SHAPE_B);
  assert.equal(app.shape, 'B');
  assert.deepEqual(app.header, { author: 'someone', generatedOn: '04-Jan-2025 15:24:33', version: '1.0' });
  assert.equal(app.name, 'Lib');
  assert.deepEqual(
    app.settings.map((p) => p.key),
    ['date format', 'share data with peers'],
  );
  assert.deepEqual(
    app.sections.map((s) => [s.name, s.displayName, s.components.map((c) => `${c.kind}:${c.name}`)]),
    [
      ['Section_1', 'Dashboard', ['page:DashBoard']],
      ['Section_2', 'Books', ['form:Book', 'list:Book_Report', 'kanban:Book_by_Genre']],
    ],
  );
});

test('form: fields, modifiers, types and actions', () => {
  const f = ir(SHAPE_B).forms[0];
  assert.equal(f.name, 'Book');
  assert.equal(f.section, 'Section_2');
  assert.deepEqual(
    f.fields.map((x) => [x.name, x.type, x.modifiers.join(' ')]),
    [
      ['Book_ID', 'autonumber', ''],
      ['Isbn_Number', 'text', 'unique'],
      ['Title', 'text', 'must have'],
      ['Genre', 'picklist', ''],
    ],
  );
  assert.equal(f.fields[0].displayName, 'Book ID');
  assert.equal(f.fields[3].properties.find((p) => p.key === 'values')?.value, '{"Sci-Fi","Fiction"}');
  assert.deepEqual(
    f.actions.map((a) => [a.event, a.buttons.map((b) => `${b.name}:${b.type}`)]),
    [
      ['on add', ['submit:submit']],
      ['on edit', ['update:submit']],
    ],
  );
});

test('reports: list and kanban, `default` modifier, source form', () => {
  const r = ir(SHAPE_B).reports;
  assert.deepEqual(
    r.map((x) => [x.type, x.name, x.form, x.modifiers.join(' '), x.displayName]),
    [
      ['list', 'Book_Report', 'Book', '', 'All Books'],
      ['kanban', 'Book_by_Genre', 'Book', 'default', undefined],
    ],
  );
});

test('page: ZML content is decoded from the Content string', () => {
  const p = ir(SHAPE_B).pages[0];
  assert.equal(p.name, 'DashBoard');
  assert.equal(p.content, '<zml\n>\n\t<layout width="100%"></layout></zml>');
});

test('workflow: one entry per event with the raw Deluge span', () => {
  const app = ir(SHAPE_B);
  const w = app.workflows;
  assert.deepEqual(
    w.map((x) => [x.name, x.label, x.container, x.form, x.recordEvent, x.event]),
    [
      ['Membership', 'Membership types', 'form', 'Book', 'on add', 'on user input of Genre'],
      ['Membership', 'Membership types', 'form', 'Book', 'on add', 'on validate'],
    ],
  );
  assert.match(w[0].deluge!.text, /if\(input\.Genre == "\}"\) \{ alert "x"; \}/);
  assert.equal(SHAPE_B.slice(w[0].deluge!.span.start, w[0].deluge!.span.end), w[0].deluge!.text);
  assert.equal(w[1].deluge!.text.trim(), 'cancel submit;');
});

test('functions: 2025 creator function with on click Deluge', () => {
  const fn = ir(SHAPE_B).functions;
  assert.equal(fn.length, 1);
  assert.equal(fn[0].kind, 'creator');
  assert.equal(fn[0].name, 'Overdue');
  assert.equal(fn[0].label, 'Overdue Report');
  assert.equal(fn[0].form, 'Book');
  assert.equal(fn[0].deluge[0].text.trim(), 'x = input.Title;');
});

test('permissions: collected with the owning profile', () => {
  const p = ir(SHAPE_B).permissions;
  assert.deepEqual(
    p.map((x) => [x.owner, x.value]),
    [['Read', '{Chat:false, ApiAccess:true}']],
  );
});

test('unknown: unrecognised constructs keep their exact source span', () => {
  const app = ir(SHAPE_B);
  assert.equal(app.unknown.length, 1);
  const u = app.unknown[0];
  assert.equal(u.keyword, 'mystery');
  assert.equal(u.context, 'application');
  assert.equal(SHAPE_B.slice(u.span.start, u.span.end), u.text);
  assert.match(u.text, /^mystery block\n\t\{\n\t\tanything = 1\n\t\}$/);
  assert.equal(app.unmodelled.length, 0, 'share_settings is modelled in IR v1');
});

test('no statement is dropped: every top-level byte is inside a statement or trivia', () => {
  const doc = parse(SHAPE_B);
  let count = 0;
  walkStatements(doc, () => count++);
  assert.ok(count > 50);
  assert.equal(print(doc), SHAPE_B);
});

const SHAPE_A = `/*
 * Author       : x
 * Generated on : 01-Jan-2016
 * Version      : 3.0
 */
application "Preview"
{
    type = public
    allow html = true
    section Home
    {
        form Add_Record
        {
            Name ( type = text width = 200px )
            Country ( type = picklist values = {"US", "UK"} sortorder = ascending )
            actions { on add { submit (type = submit) reset (type = reset) } }
        }
        list Add_Record_List
        {
            show all rows from Add_Record ( Name Country )
            filters ( Country )
            custom action "Print" ( function = openSummary(Add_Record) )
        }
    }
    section Hidden
    {
        hide = true
        summary Add_Record_Summary
        {
            show all rows from Add_Record ( Name )
            options ( display records per row = 1 )
        }
    }
    functions
    {
        void openSummary(Add_Record myRec)
        {
            openUrl("#View:Add_Record_Summary?ID=" + myRec.ID, "popup window");
        }
    }
    customize { layout = "tab" base theme = "professional" color = "black" }
}
`;

test('shape A: 2016 monolithic sample', () => {
  assertRoundTrip(SHAPE_A);
  const app = ir(SHAPE_A);
  assert.equal(app.shape, 'A');
  assert.deepEqual(
    app.settings.map((p) => [p.key, p.value]),
    [
      ['type', 'public'],
      ['allow html', 'true'],
    ],
  );
  const f = app.forms[0];
  assert.deepEqual(
    f.fields.map((x) => [x.name, x.type]),
    [
      ['Name', 'text'],
      ['Country', 'picklist'],
    ],
  );
  assert.deepEqual(
    f.actions.map((a) => [a.event, a.buttons.map((b) => b.name)]),
    [['on add', ['submit', 'reset']]],
  );
  assert.deepEqual(
    app.reports.map((r) => [r.type, r.name, r.form, r.section]),
    [
      ['list', 'Add_Record_List', 'Add_Record', 'Home'],
      ['summary', 'Add_Record_Summary', 'Add_Record', 'Hidden'],
    ],
  );
  assert.equal(app.sections[1].hidden, true);
  assert.equal(app.functions[0].kind, 'deluge');
  assert.equal(app.functions[0].name, 'openSummary');
  assert.equal(app.functions[0].signature, 'void openSummary(Add_Record myRec)');
  assert.match(app.functions[0].deluge[0].text, /openUrl\(/);
  assert.equal(app.unknown.length, 0);
});

// ---------------------------------------------------------------------------
// shape C

const C_FORM = `form Add_Order
{
    must have Item
    (
        type = text
    )
    actions
    {
        on add
        {
            submit
            (
                type = submit
            )
        }
    }
}
`;

const C_WORKFLOW = `Tasks_On_Validate as "Sync"
{
    type = form
    form = Tasks
    record event = on add or edit

    on validate
    {
        actions
        {
            custom deluge script
            (
                if (input.Status == "Completed")
                {
                    input.Completed = true;
                }
            )
        }
    }
}
`;

const C_MENU = `menu
{
    space S
    {
        section Sec
        {
            displayname = "Orders"
            form Add_Order
            {
                icon = "x"
            }
            report All_Orders
            {
                icon = "y"
            }
        }
    }
}
`;

test('shape C: fragment files parse on their own', () => {
  for (const src of [C_FORM, C_WORKFLOW, C_MENU]) assertRoundTrip(src);
  assert.equal(ir(C_FORM).shape, 'C');
  assert.equal(ir(C_FORM).forms[0].fields[0].modifiers.join(' '), 'must have');
  const w = ir(C_WORKFLOW).workflows[0];
  assert.deepEqual([w.name, w.form, w.recordEvent, w.event], ['Tasks_On_Validate', 'Tasks', 'on add or edit', 'on validate']);
  const menu = ir(C_MENU);
  assert.equal(menu.forms.length, 0, 'menu entries are references, not form definitions');
  assert.deepEqual(
    menu.sections[0].components.map((c) => [c.kind, c.name, c.properties?.map((p) => `${p.key}=${p.value}`)]),
    [
      ['form', 'Add_Order', ['icon="x"']],
      ['report', 'All_Orders', ['icon="y"']],
    ],
  );
  assert.equal(menu.sections[0].space, 'S');
});

test('shape C: a folder export merges into one IR with file-relative spans', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-'));
  try {
    mkdirSync(join(dir, 'App/common'), { recursive: true });
    mkdirSync(join(dir, 'App/components/Add_Order/form'), { recursive: true });
    mkdirSync(join(dir, 'App/devices/web'), { recursive: true });
    mkdirSync(join(dir, 'App/workflows'), { recursive: true });
    writeFileSync(join(dir, 'App/common/header.ds'), '/*\n * Author : a\n * Version : 1.0\n */\n');
    writeFileSync(join(dir, 'App/App.ds'), 'application "App"\n{\n\tdate format = "dd"\n}\n');
    writeFileSync(join(dir, 'App/components/Add_Order/form/Add_Order.ds'), C_FORM);
    writeFileSync(join(dir, 'App/devices/web/menu-sections.ds'), C_MENU);
    writeFileSync(join(dir, 'App/devices/web/forms.ds'), 'forms\n{\n    form Add_Order\n    {\n        label placement = left\n    }\n}\n');
    writeFileSync(join(dir, 'App/workflows/Tasks_On_Validate.ds'), C_WORKFLOW);
    const { files, ir: app } = parseProject(dir);
    assert.equal(files.length, 6);
    assert.ok(files.every((f) => roundTrips(f)));
    assert.equal(app.name, 'App');
    assert.equal(app.forms.length, 1);
    assert.equal(app.forms[0].fields.length, 1);
    // devices/web/forms.ds carries per-device layout settings
    assert.deepEqual(
      app.devices.map((d) => [d.device, d.forms.map((f) => [f.name, f.properties.map((p) => p.key)])]),
      [['web', [['Add_Order', ['label placement']]]]],
    );
    assert.equal(app.forms[0].span.file, 'App/components/Add_Order/form/Add_Order.ds');
    assert.equal(app.workflows[0].span.file, 'App/workflows/Tasks_On_Validate.ds');
    assert.equal(app.unknown.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bare Deluge script files are kept whole', () => {
  const src = '/* sample */\norgId = organization.get("id");\ninfo orgId;\n';
  const app = ir(src);
  assert.equal(app.shape, 'deluge');
  assert.equal(app.functions[0].kind, 'script');
  assert.match(app.functions[0].deluge[0].text, /^orgId = /);
});

test('header parsing tolerates variants', () => {
  assert.deepEqual(parseHeader('/*\n * Author : a\n * Generated on : b\n * Version : 3.0\n */'), {
    author: 'a',
    generatedOn: 'b',
    version: '3.0',
  });
  assert.deepEqual(parseHeader('/*\n * Author       : someone\n * Generated on : 04-Jan-2025 15:24:33\n * Version      : 1.0\n */'), {
    author: 'someone',
    generatedOn: '04-Jan-2025 15:24:33',
    version: '1.0',
  });
  assert.deepEqual(parseHeader('/*\n * Author       : x\n * Generated on : 01-Jan-2016\n * Version      : 3.0\n */'), {
    author: 'x',
    generatedOn: '01-Jan-2016',
    version: '3.0',
  });
  assert.equal(parseHeader('form X {}'), undefined);
  assert.equal(parseHeader('/* no keys */'), undefined);
  assert.deepEqual(parseHeader('/* * AUTHOR: a\n * author: b */'), { author: 'b' });
  assert.deepEqual(parseHeader('/* * Generated on: */'), { generatedOn: '' });
  assert.equal(parseHeader(`/* * Author: past the cap ${' '.repeat(2 * 1024 * 1024)}*/`), undefined);
});

test('header parsing stays linear on long whitespace and star lines', () => {
  const kib = 1024;
  const make = {
    spaces: (n: number) => ' '.repeat(n),
    stars: (n: number) => `/*${'*'.repeat(n)}`,
    starLine: (n: number) => `/*\n${'*'.repeat(n)}\n*/`,
    authorSpaces: (n: number) => `/*\n * Author: ${' '.repeat(n)}\n*/`,
  };
  const perCall = (src: string): number => {
    parseHeader(src);
    const start = performance.now();
    let calls = 0;
    let elapsed = 0;
    do {
      parseHeader(src);
      calls += 1;
      elapsed = performance.now() - start;
    } while (elapsed < 80);
    return elapsed / calls;
  };
  for (const [name, build] of Object.entries(make)) {
    const big = build(1024 * kib);
    const started = performance.now();
    parseHeader(big);
    const once = performance.now() - started;
    assert.ok(once < 100, `${name}: 1 MiB took ${once.toFixed(1)} ms`);
    const small = perCall(build(256 * kib));
    const large = perCall(big);
    const ratio = large / small;
    assert.ok(ratio < 6, `${name}: 1 MiB / 256 KiB = ${ratio.toFixed(2)} (${large.toFixed(3)} ms / ${small.toFixed(3)} ms)`);
  }
});

// ---------------------------------------------------------------------------
// redistributable fixtures

const FIXTURES = [
  {
    path: 'fixtures/redistributable/library-application-system/library_application.ds',
    name: 'Library_System_Application',
    forms: 4,
    reports: 5,
    pages: 1,
  },
  {
    path: 'fixtures/redistributable/freight-forwarding/Creator_app_source_code.ds',
    name: 'Freight Forwarding and Feeder Solution',
    forms: 20,
    reports: 22,
    pages: 0,
  },
];

// ---------------------------------------------------------------------------
// deep nesting (seeded fuzzing: `'{' * 4000` overflowed the recursive print)

test('print: deeply nested brackets round-trip without throwing', () => {
  for (const src of ['{'.repeat(20000), '{'.repeat(10000) + 'x = 1;' + '}'.repeat(10000)]) {
    const doc = parse(src);
    assert.equal(print(doc), src);
  }
});

test('parse: deeply nested brackets report located unclosed-bracket errors', () => {
  const src = '{'.repeat(20000);
  const doc = parse(src);
  assert.ok(doc.errors.length > 0);
  for (const e of doc.errors) {
    assert.equal(e.code, 'unclosed-bracket');
    assert.ok(e.offset >= 0 && e.offset <= src.length);
  }
});

test('deriveIr + walkStatements: deeply nested brackets do not throw', () => {
  const doc = parse('{'.repeat(20000));
  // A brace run is one settings-fragment group. detectShape returns 'C' before
  // the semicolon scan, so the assertion is that result.
  assert.equal(detectShape(doc, undefined), 'C');
  const app = deriveIr(doc);
  assert.equal(app.shape, 'C');
  assert.equal(app.statementCount, 1);
  assert.equal(app.unknown.length, 0);
  let count = 0;
  walkStatements(doc, () => {
    count++;
  });
  assert.equal(count, 1);
});

test('detectShape: a deep paren value is unknown without throwing', () => {
  // A bare `'(' * 20000` is structured recursively and never reaches the scan.
  // A property value stays flat, and a sibling word is not a settings fragment,
  // so the semicolon scan walks the paren spine. The recursive scan threw.
  const doc = parse('foo\nx = ' + '('.repeat(20000));
  assert.equal(detectShape(doc, undefined), 'unknown');
  const app = deriveIr(doc);
  assert.equal(app.shape, 'unknown');
  assert.equal(app.statementCount, 2);
});

for (const fx of FIXTURES) {
  test(`fixture round-trips byte for byte: ${fx.path}`, () => {
    const f = parseFile(fx.path);
    assert.ok(roundTrips(f));
    assert.equal(f.cst.errors.length, 0);
    assert.equal(f.ir.shape, 'B');
    assert.equal(f.ir.name, fx.name);
    assert.equal(f.ir.forms.length, fx.forms);
    assert.equal(f.ir.reports.length, fx.reports);
    assert.equal(f.ir.pages.length, fx.pages);
    assert.equal(f.ir.unknown.length, 0);
    assert.ok(f.ir.workflows.length > 0);
    assert.ok(f.ir.workflows.every((w) => w.deluge === null || f.cst.source.slice(w.deluge.span.start, w.deluge.span.end) === w.deluge.text));
  });
}
