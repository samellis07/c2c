import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translate } from '../src/translate.js';

// Generated table: one `m` assigned through nested if/else chains, then read by
// `ui.add(m)`. The oracle is computed from the shape, not from the translator:
// the set of leaf definitions that reach the ui.add.

type Leaf = 'app' | 'write' | 'lit' | 'none';
const LEAVES: Leaf[] = ['app', 'write', 'lit', 'none'];

function leafSrc(kind: Leaf, i: number): string {
  switch (kind) {
    case 'app': return `m = thisapp.Rooms.f${i}(input.N);`;
    case 'write': return 'm = insert into Staff [Name = input.N];';
    case 'lit': return 'm = "A";';
    case 'none': return `x${i} = 1;`;
  }
}

// depth 0: one statement. depth k: k nested ifs, each outer `then` holding the
// next if and each `else` one leaf; the innermost if has two leaves.
function build(depth: number, leaves: Leaf[], at: { i: number }): string {
  if (depth === 0) return leafSrc(leaves[at.i]!, at.i++);
  const inner = depth === 1 ? `{ ${leafSrc(leaves[at.i]!, at.i++)} }` : `{ ${build(depth - 1, leaves, at)} }`;
  return `if (input.N == "T${depth}") ${inner} else { ${leafSrc(leaves[at.i]!, at.i++)} }`;
}

function* combos(n: number): Generator<Leaf[]> {
  const total = LEAVES.length ** n;
  for (let k = 0; k < total; k++) {
    const out: Leaf[] = [];
    for (let j = 0, r = k; j < n; j++, r = Math.floor(r / LEAVES.length)) out.push(LEAVES[r % LEAVES.length]!);
    yield out;
  }
}

const manual = (src: string): string[] =>
  translate(src, { formNames: ['Staff', 'Rooms'], inputFields: ['N', 'Room'] })
    .todos.filter((t) => t.construct === 'client-condition-uses-server')
    .map((t) => t.manualStep ?? '');

test('the cause text follows the set of reaching definitions for every generated shape', () => {
  let cases = 0;
  let named = 0;
  for (let depth = 0; depth <= 3; depth++) {
    for (const leaves of combos(depth + 1)) {
      for (const loop of [false, true]) {
        for (const pre of [false, true]) {
          const body = build(depth, leaves, { i: 0 });
          const structure = `${pre ? 'm = "P";\n' : ''}${body}`;
          const src = loop ? `for each r in Rooms[ID != 0] { ${structure} }\ninput.Room:ui.add(m);` : `${structure}\ninput.Room:ui.add(m);`;
          const label = `${depth}/${leaves.join(',')}/${loop ? 'loop' : 'flat'}/${pre ? 'pre' : 'nopre'}\n${src}`;
          const texts = manual(src);
          cases++;
          const nondet = leaves.flatMap((k, i) => (k === 'app' || k === 'write' ? [{ k, i }] : []));
          const reachesNone = !pre && (loop || leaves.includes('none'));
          const sourceCallees = new Set([...src.matchAll(/thisapp\.[\w.]+/g)].map((x) => x[0]));
          for (const text of texts) {
            assert.doesNotMatch(text, /\u0000|#[0-9]/, `no internal names: ${label}`);
            for (const c of text.matchAll(/thisapp\.[\w.]+/g)) {
              const callee = c[0].replace(/[.,]$/, '');
              assert.ok(sourceCallees.has(callee), `callee ${callee} is in the source: ${label}`);
            }
            if (/not assigned on every path/.test(text)) assert.ok(reachesNone, `claims an unassigned path that does not exist: ${label}\n${text}`);
          }
          if (texts.length && nondet.length === 1) {
            const only = nondet[0]!;
            const text = texts[0]!;
            if (only.k === 'app') assert.ok(text.includes(`thisapp.Rooms.f${only.i}`), `names the one app function: ${label}\n${text}`);
            else assert.match(text, /from a write, mail or outbound call/, label);
            named++;
          }
        }
      }
    }
  }
  assert.ok(cases >= 800, `enumerated ${cases} cases`);
  assert.ok(named >= 100, `exactly-one-origin cases that raised a manual step: ${named}`);
});

test('a path that truly reaches the ui.add with no definition says so', () => {
  for (const src of [
    'if (input.N == "A") { m = Rooms[ID != 0].Room_No.getAll(); }\ninput.Room:ui.add(m);',
    'if (input.N == "A") { if (input.N == "B") { m = Rooms[ID != 0].Room_No.getAll(); } }\ninput.Room:ui.add(m);',
    'if (input.N == "A") { m = Rooms[ID != 0].Room_No.getAll(); } else { y = 1; }\ninput.Room:ui.add(m);',
  ]) {
    assert.match(manual(src)[0] ?? '', /reads `m`, which is not assigned on every path/, src);
  }
});

test('nested if/else with an assignment in every arm names the origin, not a missing assignment', () => {
  const text = manual('if (input.N == "A") { if (input.N == "B") { m = insert into Staff [Name = input.N]; } else { m = insert into Staff [Name = input.N]; } } else { m = "A"; }\ninput.Room:ui.add(m);')[0] ?? '';
  assert.match(text, /through `m` from a write, mail or outbound call/);
  assert.doesNotMatch(text, /not assigned/);
});

test('a value derived from an app call names that call', () => {
  const text = manual('m = thisapp.Rooms.book(input.N);\nrooms = m.get("Rooms").toList();\ninput.Room:ui.add(rooms);')[0] ?? '';
  assert.match(text, /through `rooms` from thisapp\.Rooms\.book/);
});
