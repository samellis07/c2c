import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { canonicalSeedJson, generateSeed } from '../src/index.js';

function appOf(body: string, name = 'Demo'): App {
  return deriveIr(parse(`application "${name}"\n{\n${body}\n}\n`));
}

const APP = appOf(
  `\tform Author
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t\tmust have Level
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = {"A","B, C","D"}
\t\t)
\t\tunique Code
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Book
\t{
\t\tmust have Title
\t\t(
\t\t\ttype = text
\t\t)
\t\tAuthor
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Author.Name
\t\t)
\t\tHint
\t\t(
\t\t\ttype = plaintext
\t\t)
\t}`,
);

function parseCsv(csv: string): string[][] {
  return csv.trimEnd().split('\n').map((line) => {
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    return cells;
  });
}

test('the same seed is byte-identical and a different seed is not', () => {
  const a = generateSeed(APP, { n: 5, seed: 'library' });
  const b = generateSeed(APP, { n: 5, seed: 'library' });
  assert.deepEqual(a.files.map((file) => file.csv), b.files.map((file) => file.csv));
  const c = generateSeed(APP, { n: 5, seed: 'other-app' });
  assert.notEqual(a.files.map((file) => file.csv).join(''), c.files.map((file) => file.csv).join(''));
});

test('default n is 50 and parents are written before lookups', () => {
  const seed = generateSeed(APP, { seed: 'library' });
  assert.equal(seed.n, 50);
  assert.deepEqual(seed.order, ['Author', 'Book']);
  assert.equal(seed.files[0].form, 'Author');
  const author = parseCsv(seed.files[0].csv);
  const book = parseCsv(seed.files[1].csv);
  assert.equal(author.length, 51);
  assert.deepEqual(author[0], ['Name', 'Level', 'Code']);
  assert.deepEqual(book[0], ['Title', 'Author']);
  const levels = new Set(['A', 'B, C', 'D']);
  const names = new Set(author.slice(1).map((row) => row[0]));
  const codes = author.slice(1).map((row) => row[2]);
  assert.equal(new Set(codes).size, 50);
  for (const row of author.slice(1)) {
    assert.ok(row[0].length > 0);
    assert.ok(levels.has(row[1]), row[1]);
    assert.ok(row[2].length > 0);
  }
  for (const row of book.slice(1)) {
    assert.ok(row[0].length > 0);
    assert.ok(names.has(row[1]), row[1]);
  }
});

test('a checkboxes field with no values leaves empty cells and warns', () => {
  const ir = appOf(
    `\tform Tags
\t{
\t\tPicks
\t\t(
\t\t\ttype = checkboxes
\t\t)
\t}`,
  );
  const seed = generateSeed(ir, { n: 5, seed: 'library' });
  const rows = parseCsv(seed.files[0].csv);
  assert.deepEqual(rows[0], ['Picks']);
  for (const row of rows.slice(1)) assert.equal(row[0], '');
  for (const row of seed.tables[0].rows) assert.equal(row.columns.Picks, '');
  assert.ok(seed.warnings.some((w) => w.form === 'Tags' && w.field === 'Picks'));
});

test('a lookup stored as Form.ID still uses the parent display value', () => {
  const ir = appOf(
    `\tform Author
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Book
\t{
\t\tAuthor
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Author.ID
\t\t)
\t}`,
  );
  const seed = generateSeed(ir, { n: 3, seed: 'library' });
  const author = parseCsv(seed.files[0].csv);
  const book = parseCsv(seed.files[1].csv);
  const names = new Set(author.slice(1).map((row) => row[0]));
  for (const row of book.slice(1)) assert.ok(names.has(row[0]));
  assert.equal(seed.files[0].csv.includes('ID'), false);
});

test('contacts Picture gets a valid PNG, identical across runs', () => {
  const app = appOf(
    `\tform Contacts
\t{
\t\tmust have Picture
\t\t(
\t\t\ttype = image
\t\t)
\t\tDocument
\t\t(
\t\t\ttype = file upload
\t\t)
\t\tSignature
\t\t(
\t\t\ttype = signature
\t\t)
\t\tClip
\t\t(
\t\t\ttype = audio
\t\t)
\t\tFilm
\t\t(
\t\t\ttype = video
\t\t)
\t}`,
  );
  const once = generateSeed(app, { n: 2, seed: 'test' });
  const twice = generateSeed(app, { n: 2, seed: 'test' });
  const files = once.fixtureFiles;
  const again = twice.fixtureFiles;
  assert.ok(files.length > 0);
  assert.deepEqual(
    files.map((item) => ({ name: item.name, type: item.contentType, bytes: [...item.bytes] })),
    again.map((item) => ({ name: item.name, type: item.contentType, bytes: [...item.bytes] })),
  );
  const picture = files.find((item) => item.name.endsWith('-Picture-value.png'));
  assert.ok(picture);
  assert.equal(picture.contentType, 'image/png');
  assert.equal(picture.bytes[0], 0x89);
  assert.equal(picture.bytes[1], 0x50);
  assert.equal(picture.bytes[2], 0x4e);
  assert.equal(picture.bytes[3], 0x47);
  assert.equal(files.filter((item) => item.name.includes('Picture')).length, 1);
  for (const row of once.tables[0].rows) assert.equal(row.columns.Picture, picture.name);
  const doc = files.find((item) => item.name.endsWith('-Document-value.pdf'));
  assert.ok(doc);
  assert.equal(doc.contentType, 'application/pdf');
  assert.equal(doc.bytes[0], 0x25);
  assert.equal(doc.bytes[1], 0x50);
  assert.equal(doc.bytes[2], 0x44);
  assert.equal(doc.bytes[3], 0x46);
  const signature = files.find((item) => item.name.endsWith('-Signature-value.png'));
  assert.ok(signature);
  assert.equal(signature.contentType, 'image/png');
  assert.deepEqual(signature.bytes, picture.bytes);
  for (const fieldName of ['Clip', 'Film']) {
    const sample = files.find((item) => item.name.endsWith(`-${fieldName}-value.pdf`));
    assert.ok(sample, fieldName);
    assert.equal(sample.contentType, 'application/pdf');
  }
});

test('a unique image field gets one PNG name per row', () => {
  const app = appOf(
    `\tform Contacts
\t{
\t\tunique Picture
\t\t(
\t\t\ttype = image
\t\t)
\t}`,
  );
  const once = generateSeed(app, { n: 2, seed: 'test' });
  const twice = generateSeed(app, { n: 2, seed: 'test' });
  const files = once.fixtureFiles;
  assert.equal(files.length, 2);
  assert.notEqual(files[0].name, files[1].name);
  assert.ok(files[0].name.endsWith('.png'));
  assert.equal(files[0].bytes[0], 0x89);
  assert.deepEqual(files[0].bytes, files[1].bytes);
  assert.deepEqual(
    files.map((item) => item.name),
    twice.fixtureFiles.map((item) => item.name),
  );
  assert.deepEqual([...files[0].bytes], [...twice.fixtureFiles[0].bytes]);
  assert.equal(once.tables[0].rows[0].columns.Picture, files[0].name);
  assert.equal(once.tables[0].rows[1].columns.Picture, files[1].name);
});
test('multi-lookup generates junction rows and does not write to parent table', () => {
  const ir = appOf(
    `\tform Tag
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Post
\t{
\t\tTitle
\t\t(
\t\t\ttype = text
\t\t)
\t\tTags
\t\t(
\t\t\ttype = checkbox
\t\t\tvalues = Tag.Name
\t\t)
\t}`
  );
  const seed = generateSeed(ir, { n: 2, seed: 'blog' });
  const tables = seed.tables;
  assert.equal(tables.length, 3, 'generates Tag, Post, and Post__Tags junction');
  
  const post = tables.find((t) => t.form === 'Post');
  assert.ok(post);
  for (const row of post.rows) {
    assert.equal(row.columns.Tags, undefined, 'multi-lookup is not written to the parent column');
  }

  const junction = tables.find((t) => t.form === 'Post__Tags');
  assert.ok(junction);
  assert.ok(junction.rows.length > 0, 'junction table has rows');
  for (const row of junction.rows) {
    assert.ok(row.columns.parent_id, 'junction row has parent_id');
    assert.ok(row.columns.Tags, 'junction row has related id');
  }
});

const MULTI = appOf(
  `\tform Tag
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Post
\t{
\t\tTitle
\t\t(
\t\t\ttype = text
\t\t)
\t\tTags
\t\t(
\t\t\ttype = checkbox
\t\t\tvalues = Tag.Name
\t\t)
\t}`,
);

test('multi-lookup junction pairs are unique for each parent and repeat for the same seed', () => {
  // Parent and target forms both receive this many rows, so the run covers target lengths 1, 2 and 7.
  const rowCounts = [1, 2, 3, 7, 14, 20];
  const seeds = ['tags', 'blog'];
  for (const seedName of seeds) {
    for (const n of rowCounts) {
      const first = generateSeed(MULTI, { n, seed: seedName });
      const second = generateSeed(MULTI, { n, seed: seedName });
      assert.deepEqual(second.tables, first.tables, `seed ${seedName} n=${n} changed between runs`);
      assert.deepEqual(
        second.files.map((file) => file.csv),
        first.files.map((file) => file.csv),
        `seed ${seedName} n=${n} csv changed between runs`,
      );
      const tags = first.tables.find((table) => table.form === 'Tag');
      const posts = first.tables.find((table) => table.form === 'Post');
      const junction = first.tables.find((table) => table.form === 'Post__Tags');
      assert.ok(tags);
      assert.ok(posts);
      assert.ok(junction);
      assert.equal(tags.rows.length, n, `target size ${n}`);
      assert.equal(posts.rows.length, n);
      const tagIds = new Set(tags.rows.map((row) => row.id));
      const postIds = posts.rows.map((row) => row.id);
      const pairs = new Set<string>();
      const perParent = new Map<string, number>();
      for (const row of junction.rows) {
        const parentId = row.columns.parent_id;
        const targetId = row.columns.Tags;
        assert.ok(postIds.includes(parentId), parentId);
        assert.ok(tagIds.has(targetId), targetId);
        const pair = `${parentId}\0${targetId}`;
        assert.equal(pairs.has(pair), false, `duplicate pair at n=${n} seed=${seedName} target size ${tags.rows.length}`);
        pairs.add(pair);
        perParent.set(parentId, (perParent.get(parentId) ?? 0) + 1);
      }
      assert.equal(perParent.size, n, `every parent has a link when n=${n}`);
      for (const count of perParent.values()) {
        assert.ok(count >= 1 && count <= tags.rows.length, `picked ${count} links for target size ${tags.rows.length}`);
      }
      const postFile = first.files.find((file) => file.form === 'Post');
      assert.ok(postFile);
      const csv = parseCsv(postFile.csv);
      assert.equal(csv[0][1], 'Tags');
      for (let i = 0; i < n; i++) {
        const cell = csv[i + 1][1];
        const shown = cell === '' ? 0 : cell.split(',').length;
        assert.equal(shown, perParent.get(postIds[i]), `csv links differ from junction rows at n=${n} row ${i}`);
      }
    }
  }
});

test('a mandatory checkboxes field with no values generates a blocker and omits the form', () => {
  const ir = appOf(
    `\tform Tags
\t{
\t\tmust have Picks
\t\t(
\t\t\ttype = checkboxes
\t\t)
\t\tOther
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Keeps
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}`,
  );
  const seed = generateSeed(ir, { n: 5, seed: 'library' });
  assert.equal(seed.blockers.length, 1);
  assert.equal(seed.blockers[0].form, 'Tags');
  assert.equal(seed.blockers[0].field, 'Picks');
  assert.ok(seed.blockers[0].message.includes('required choice field has no choices'));

  // The 'Tags' form should be omitted entirely from files, tables, and order
  assert.ok(!seed.order.includes('Tags'));
  assert.equal(seed.files.some(f => f.form === 'Tags'), false);
  assert.equal(seed.tables.some(t => t.form === 'Tags'), false);

  // The 'Keeps' form should remain
  assert.ok(seed.order.includes('Keeps'));
  assert.equal(seed.files.some(f => f.form === 'Keeps'), true);
  assert.equal(seed.tables.some(t => t.form === 'Keeps'), true);
});

test('a required lookup to a blocked form blocks the dependent, transitively', () => {
  const ir = appOf(
    `\tform Parent
\t{
\t\tmust have Picks
\t\t(
\t\t\ttype = checkboxes
\t\t)
\t}
\tform Child
\t{
\t\tmust have Parent
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Parent.Name
\t\t)
\t}
\tform Grand
\t{
\t\tmust have Child
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Child.Name
\t\t)
\t}`,
  );
  const seed = generateSeed(ir, { n: 5, seed: 'library' });
  assert.equal(seed.order.length, 0);
  assert.equal(seed.files.length, 0);
  assert.equal(seed.tables.length, 0);
  const parent = seed.blockers.find((b) => b.form === 'Parent');
  assert.ok(parent?.message.includes('required choice field has no choices'));
  const child = seed.blockers.find((b) => b.form === 'Child');
  assert.equal(child?.field, 'Parent');
  assert.match(child?.message ?? '', /depends on blocked form Parent \(required lookup Parent\)/);
  const grand = seed.blockers.find((b) => b.form === 'Grand');
  assert.equal(grand?.field, 'Child');
  assert.match(grand?.message ?? '', /depends on blocked form Child \(required lookup Child\)/);
});

test('an optional lookup to a blocked form leaves empty cells and names the block', () => {
  const ir = appOf(
    `\tform Parent
\t{
\t\tmust have Picks
\t\t(
\t\t\ttype = checkboxes
\t\t)
\t}
\tform Opt
\t{
\t\tParent
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = Parent.Name
\t\t)
\t\tTitle
\t\t(
\t\t\ttype = text
\t\t)
\t}`,
  );
  const seed = generateSeed(ir, { n: 3, seed: 'library' });
  assert.deepEqual(seed.order, ['Opt']);
  const rows = parseCsv(seed.files[0].csv);
  assert.deepEqual(rows[0], ['Parent', 'Title']);
  for (const row of rows.slice(1)) assert.equal(row[0], '');
  for (const row of seed.tables[0].rows) assert.equal(row.columns.Parent, undefined);
  const warning = seed.warnings.find((w) => w.form === 'Opt' && w.field === 'Parent');
  assert.match(warning?.message ?? '', /parent form Parent is blocked; lookup left empty/);
  assert.equal(seed.warnings.some((w) => w.message.includes('no parent display value')), false);
});

test('a form used as a linked subform of a blocked form is blocked with the parent', () => {
  const ir = appOf(
    `\tform Parent
\t{
\t\tmust have Picks
\t\t(
\t\t\ttype = checkboxes
\t\t)
\t\tKids
\t\t(
\t\t\ttype = subform
\t\t\tvalues = Child.Name
\t\t)
\t}
\tform Child
\t{
\t\tTitle
\t\t(
\t\t\ttype = text
\t\t)
\t}`,
  );
  const seed = generateSeed(ir, { n: 5, seed: 'library' });
  assert.equal(seed.order.length, 0);
  const child = seed.blockers.find((b) => b.form === 'Child');
  assert.equal(child?.field, 'Kids');
  assert.match(child?.message ?? '', /depends on blocked form Parent \(subform field Kids\)/);
});

test('a form named c2c_blocked is refused so the reserved key is never a table', () => {
  const ir = appOf(
    `\tform c2c_blocked
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tform Keeps
\t{
\t\tName
\t\t(
\t\t\ttype = text
\t\t)
\t}`,
  );
  const seed = generateSeed(ir, { n: 2, seed: 'library' });
  assert.equal(seed.blockers.length, 1);
  assert.equal(seed.blockers[0].form, 'c2c_blocked');
  assert.match(seed.blockers[0].message, /reserved/);
  assert.ok(!seed.order.includes('c2c_blocked'));
  assert.equal(seed.files.some((f) => f.form === 'c2c_blocked'), false);
  assert.equal(seed.tables.some((t) => t.form === 'c2c_blocked'), false);
  const parsed = JSON.parse(canonicalSeedJson(seed.tables, seed.blockers)) as Record<string, unknown>;
  assert.deepEqual(parsed.c2c_blocked, [
    { form: 'c2c_blocked', reason: 'form name c2c_blocked is reserved for the seed blocker record; rename the form' },
  ]);
  assert.deepEqual(Object.keys(parsed).filter((key) => key !== 'c2c_blocked'), ['Keeps']);
});

test('a blocked parent blocks its inline subform child table and a required multi-lookup dependent', () => {
  const ir = appOf(
    `\tform Parent
\t{
\t\tmust have Picks
\t\t(
\t\t\ttype = checkboxes
\t\t)
\t\tKids
\t\t(
\t\t\ttype = grid
\t\t\tLabel
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t)
\t}
\tform Post
\t{
\t\tTitle
\t\t(
\t\t\ttype = text
\t\t)
\t\tmust have Tags
\t\t(
\t\t\ttype = checkbox
\t\t\tvalues = Parent.Name
\t\t)
\t}`,
  );
  const seed = generateSeed(ir, { n: 2, seed: 'library' });
  assert.equal(seed.order.length, 0);
  assert.equal(seed.files.length, 0);
  assert.equal(seed.tables.length, 0);
  // Parent (required choice), the inline-subform child table, and the
  // required multi-lookup dependent are all blocked; no junction is emitted.
  assert.equal(seed.blockers.length, 3);
  assert.ok(seed.blockers.some((b) => b.form === 'Parent' && b.message.includes('required choice field has no choices')));
  const child = seed.blockers.find((b) => b.message === 'depends on blocked form Parent (subform field Kids)');
  assert.ok(child);
  assert.notEqual(child.form, 'Parent');
  assert.notEqual(child.form, 'Post');
  const post = seed.blockers.find((b) => b.form === 'Post');
  assert.match(post?.message ?? '', /depends on blocked form Parent \(required lookup Tags\)/);
});
