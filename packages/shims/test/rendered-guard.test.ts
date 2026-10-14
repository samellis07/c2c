/**
 * The post-render markup guard parses the HTML a generated page endpoint is
 * about to return and lists every parsed element with its attributes, so a
 * caller-side policy sees exactly what the DOM parser produced — including
 * attributes a tag-breaking value smuggled in.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderedDocumentViolation, renderedHtmlElements } from '../src/rendered-guard.js';

test('the render audit reports attributes the parser derived from broken markup', () => {
  const html = '<div style="color:red<a href="https://x.test/y onclick=globalThis.__hit=1//">text</a>"></div>';
  const elements = renderedHtmlElements(html);
  const names = elements.flatMap((el) => el.attributes.map((attr) => `${el.tag}.${attr.name.toLowerCase()}`));
  assert.equal(names.some((name) => /\.on\w+$/.test(name)), true, JSON.stringify(names));
});

test('the render audit sees safe markup as plain elements', () => {
  const elements = renderedHtmlElements('<div style="color:red"><a href="https://x.test/" rel="noopener noreferrer">go</a></div>');
  const tags = elements.map((el) => el.tag);
  assert.deepEqual(tags, ['div', 'a']);
  const names = elements.flatMap((el) => el.attributes.map((attr) => attr.name.toLowerCase()));
  assert.equal(names.some((name) => name.startsWith('on')), false, JSON.stringify(names));
});

test('the render audit reads nested elements in document order', () => {
  const elements = renderedHtmlElements('<div>a<span><b title="t">b</b></span></div>');
  const tags = elements.map((el) => el.tag);
  assert.deepEqual(tags, ['div', 'span', 'b']);
  const bold = elements.find((el) => el.tag === 'b');
  assert.deepEqual(bold?.attributes, [{ name: 'title', value: 't' }]);
});

test('the document check refuses attributes on the html, head, and body elements', () => {
  // The fragment walk drops these start tags, so only a document parse sees
  // the attributes a document consumer would run.
  assert.equal(renderedDocumentViolation('<body onload=alert(1)><p>x</p>'), 'body onload');
  assert.equal(renderedDocumentViolation('<html onload=alert(1)><p>x</p>'), 'html onload');
  assert.equal(renderedDocumentViolation('<head onload=alert(1)><p>x</p>'), 'head onload');
  assert.equal(renderedDocumentViolation('<frameset onload=alert(1)>'), 'element frameset');
});

test('the document check refuses attributes merged onto the html and body elements', () => {
  // A repeated html or body start tag does not build a second element: the
  // document parser merges its attributes onto the element already open, so
  // these forms reach the audit the same way as leading tags do.
  assert.equal(renderedDocumentViolation('<p>x</p><body onload=alert(1)>'), 'body onload');
  assert.equal(renderedDocumentViolation('<p>x</p><html onload=alert(1)>'), 'html onload');
  // A body end tag moves the parser to "after body", where a stray token is
  // reprocessed in body — a second body start tag still merges its
  // attributes onto the open body element.
  assert.equal(renderedDocumentViolation('</body><body onload=alert(1)>'), 'body onload');
});

test('the document check keeps plain markup and a frameset token the parser drops', () => {
  assert.equal(renderedDocumentViolation('<p>x</p>'), '');
  assert.equal(renderedDocumentViolation('<html><body><p>x</p></body></html>'), '');
  // After body content the document grammar ignores a frameset start tag, so
  // it builds no element and there is nothing to refuse.
  assert.equal(renderedDocumentViolation('<p>x</p><frameset onload="alert(1)">'), '');
});
