import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DelugeConversionError } from '../src/convert.js';
import { DelugeRuntimeError } from '../src/errors.js';
import { executeXpath, toXml, toXmlList } from '../src/xml.js';

const BOOKSTORE =
  '<bookstore><book category="COOKING"><title lang="en">Everyday Italian</title><author>Giada De Laurentiis</author><year>2005</year><price>30.00</price></book><book category="CHILDREN"><title lang="en">Harry Potter</title><author>J K. Rowling</author><year>2005</year><price>29.99</price></book><book category="WEB"><title lang="en">Learning XML</title><author>Erik T. Ray</author><year>2003</year><price>39.95</price></book></bookstore>';

test('toXml converts the documented map text into repeated elements under root', () => {
  // https://www.zoho.com/deluge/help/functions/xml/toxml.html
  // Source order, not the help comment's OrderNo-before-Name layout.
  assert.equal(
    toXml("{Name:'Lia Shelton', OrderNo:[343,443,577]}"),
    '<root><Name>Lia Shelton</Name><OrderNo>343</OrderNo><OrderNo>443</OrderNo><OrderNo>577</OrderNo></root>',
  );
  assert.equal(
    toXml('{"Name":"Lia Shelton","OrderNo":[343,443,577]}'),
    '<root><Name>Lia Shelton</Name><OrderNo>343</OrderNo><OrderNo>443</OrderNo><OrderNo>577</OrderNo></root>',
  );
});

test('toXml key order follows the text, and escaping is not optional', () => {
  assert.equal(toXml("{OrderNo:[1], Name:'A'}"), '<root><OrderNo>1</OrderNo><Name>A</Name></root>');
  assert.equal(toXml('{"a":"x<y>&\\"z"}'), '<root><a>x&lt;y&gt;&amp;"z</a></root>');
  assert.equal(toXml('{"address":{"city":"Surat"}}'), '<root><address><city>Surat</city></address></root>');
  assert.equal(toXml('{"ok":true,"n":0}'), '<root><ok>true</ok><n>0</n></root>');
  assert.equal(toXml('{}'), '<root></root>');
  assert.equal(toXml('{"a":[]}'), '<root></root>');
  assert.throws(() => toXml('{"a":null}'), DelugeConversionError);
  assert.throws(() => toXml('not a map'), DelugeConversionError);
  assert.throws(() => toXml(''), DelugeConversionError);
  assert.throws(() => toXml(null), DelugeConversionError);
  assert.throws(() => toXml('[1,2]'), DelugeConversionError);
  assert.throws(() => toXml('{"a":[[1]]}'), DelugeConversionError);
  assert.throws(() => toXml('{"1bad":1}'), DelugeConversionError);
});

test('executeXpath returns the documented node, attribute, and text values', () => {
  // https://www.zoho.com/deluge/help/xml-manipulation/executexpath.html
  assert.equal(executeXpath('{"address":{"city":"Surat"}}', '/root/address/city'), '<city>Surat</city>');
  assert.equal(executeXpath('{"address":{"city":"Surat"}}', '/root/address/city/text()'), 'Surat');
  const link = '<a href="https://eg4.nic.in/jnv/DFILES/EBOOKS/IR/HarryPotter.pdf" target="_blank">Harry Potter</a>';
  assert.equal(
    executeXpath(executeXpath(link, '/a/@href'), '/href/text()'),
    'https://eg4.nic.in/jnv/DFILES/EBOOKS/IR/HarryPotter.pdf',
  );
  assert.equal(executeXpath(executeXpath(BOOKSTORE, '/bookstore/book[3]'), '/book/title/text()'), 'Learning XML');
  assert.equal(executeXpath(BOOKSTORE, '/bookstore/book[1]/title/text()'), 'Everyday Italian');
  assert.equal(executeXpath(BOOKSTORE, '/bookstore/book[2]/title/text()'), 'Harry Potter');
});

test('executeXpath joins every text node and keeps element order for toXmlList', () => {
  assert.equal(
    executeXpath(BOOKSTORE, '/bookstore/book/title/text()'),
    'Everyday Italian-|-Harry Potter-|-Learning XML',
  );
  assert.equal(executeXpath(BOOKSTORE, '/bookstore/book[@category="WEB"]/title/text()'), 'Learning XML');
  assert.equal(executeXpath(BOOKSTORE, "/bookstore/book[@category='CHILDREN']/author/text()"), 'J K. Rowling');
  assert.equal(executeXpath(BOOKSTORE, '/bookstore/book[price>35]/title/text()'), 'Learning XML');
  assert.equal(executeXpath(BOOKSTORE, '/bookstore/book[price>=30]/title/text()'), 'Everyday Italian-|-Learning XML');
  const multi = '<bookstore><book><price>10</price><price>40</price><title>Multi</title></book><book><price>10</price><title>Low</title></book></bookstore>';
  assert.equal(executeXpath(multi, '/bookstore/book[price>35]/title/text()'), 'Multi');
  assert.equal(
    executeXpath('<root><foo:singer id="6">Ray Charles</foo:singer><foo:singer id="7">Other</foo:singer></root>', '/root/foo:singer[@id=6]/text()'),
    'Ray Charles',
  );
  const books = toXmlList(executeXpath(BOOKSTORE, '/bookstore/book'));
  assert.equal(books.length, 3);
  assert.equal(executeXpath(books[0], '/book/title/text()'), 'Everyday Italian');
  assert.equal(executeXpath(books[2], '/book/title/text()'), 'Learning XML');
  assert.equal(executeXpath(books[2], '/book/@category'), '<category>WEB</category>');
  assert.equal(toXmlList(executeXpath(books[2], '/book/*')).length, 4);
});

test('executeXpath is case-sensitive, does not trim text, and rejects unsafe XML', () => {
  assert.equal(executeXpath('<A><B>1</B></A>', '/a/b/text()'), '');
  assert.equal(executeXpath('<A><B>1</B></A>', '/A/B/text()'), '1');
  assert.equal(executeXpath('<a> Hi </a>', '/a/text()'), ' Hi ');
  assert.equal(executeXpath('<a>&amp;amp;</a>', '/a/text()'), '&amp;');
  assert.equal(executeXpath('<a>&amp;amp;</a>', '/a'), '<a>&amp;amp;</a>');
  assert.equal(executeXpath('<a><![CDATA[x<y]]></a>', '/a/text()'), 'x<y');
  assert.equal(executeXpath('<a><![CDATA[x<y]]></a>', '/a'), '<a>x&lt;y</a>');
  assert.equal(executeXpath('<?xml version="1.0"?><!-- c --><a>Hi</a>', '/a/text()'), 'Hi');
  assert.equal(executeXpath('<r><a><title>T</title></a><title>U</title></r>', '//title/text()'), 'T-|-U');
  assert.equal(executeXpath('<r><a href="h1"/><a href="h2"/></r>', '/r/a/@href'), '<href>h1</href><href>h2</href>');
  assert.equal(executeXpath(executeXpath('<r><a href="h1"/><a href="h2"/></r>', '/r/a/@href'), '/href/text()'), 'h1-|-h2');
  const xxe = '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>';
  assert.throws(() => executeXpath(xxe, '/foo/text()'), (err: unknown) => {
    assert.ok(err instanceof DelugeRuntimeError);
    assert.match((err as Error).message, /DOCTYPE/);
    assert.doesNotMatch((err as Error).message, /passwd/);
    return true;
  });
  assert.throws(() => executeXpath('<foo>&xxe;</foo>', '/foo/text()'), /entity is not allowed/);
  assert.throws(() => executeXpath('<a/>', 'name()'), /Invalid Xpath/);
  assert.throws(() => executeXpath('<a/>', 'a'), /Invalid Xpath/);
  assert.throws(() => executeXpath('<a/>', ''), /Invalid Xpath/);
  assert.throws(() => executeXpath('<a/>', null as unknown as string), /Invalid Xpath/);
  assert.throws(() => executeXpath(null, '/a'), /not XML or JSON/);
  assert.throws(() => toXmlList('not xml'), DelugeConversionError);
  assert.throws(() => toXmlList('<a>1</a>text<b>2</b>'), DelugeConversionError);
});

test('executeXpath applies [n] per context node, not on the merged node-set', () => {
  // XPath 1.0: /r/a/b[1] is the first b child of EACH a.
  const doc = '<r><a><b>1</b><b>2</b></a><a><b>3</b><b>4</b></a></r>';
  assert.equal(executeXpath(doc, '/r/a/b[1]/text()'), '1-|-3');
  assert.equal(executeXpath(doc, '/r/a/b[2]/text()'), '2-|-4');
  assert.equal(executeXpath(doc, '//b[1]/text()'), '1-|-3');
  assert.equal(executeXpath(doc, '/r/a[1]/b[2]/text()'), '2');
  assert.equal(executeXpath(doc, '/r/a[2]/b[1]/text()'), '3');
  assert.equal(executeXpath(doc, '/r/a/b[3]/text()'), '');
  // Comparison predicates still filter per host, then merge.
  const shop = '<r><s><i p="1"/><i p="9"/></s><s><i p="2"/><i p="8"/></s></r>';
  assert.equal(executeXpath(shop, '/r/s/i[@p>5]'), '<i p="9"></i><i p="8"></i>');
  assert.equal(executeXpath(shop, '/r/s/i[2]/@p'), '<p>9</p><p>8</p>');
});

test('toXml rejects nesting deeper than the depth limit with a Deluge error', () => {
  const deep = (n: number) => '{"a":'.repeat(n) + '1' + '}'.repeat(n);
  assert.equal(toXml(deep(256)), `<root>${'<a>'.repeat(256)}1${'</a>'.repeat(256)}</root>`);
  assert.throws(() => toXml(deep(257)), (err: unknown) => {
    assert.ok(err instanceof DelugeConversionError);
    assert.match((err as Error).message, /depth limit/);
    return true;
  });
  const loose = (n: number) => '{a:'.repeat(n) + '1' + '}'.repeat(n);
  assert.throws(() => toXml(loose(300)), /depth limit/);
  // A plain object (not text) hits the same cap in the emitter.
  let obj: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < 300; i++) obj = { a: obj };
  assert.throws(() => toXml(obj), /depth limit/);
  // And executeXpath on deep JSON fails with a Deluge error, not a RangeError.
  assert.throws(() => executeXpath(deep(1e5), '/root/a'), /depth limit/);
});

test('executeXpath bounds // work and result size with a clear error', () => {
  // 390 chains of 250-deep <a> (~680 KB, ~97k elements): under the input caps.
  const chain = '<a>'.repeat(250) + 'x' + '</a>'.repeat(250);
  const doc = `<r>${chain.repeat(390)}</r>`;
  assert.throws(() => executeXpath(doc, '//*//*'), (err: unknown) => {
    assert.ok(err instanceof DelugeRuntimeError);
    assert.match((err as Error).message, /result exceeds/);
    return true;
  });
  // The output cap is deterministic; bounded queries over the same input
  // remain valid: // runs once from the
  // topmost context, and a same-name sibling list is a real selection.
  assert.equal(toXmlList(executeXpath(doc, '/r/a')).length, 390);
  assert.equal(executeXpath(doc, '//a[250]/text()'), '');
  // Every a is the first a child of its parent, so //a[1] selects all of
  // them; only the innermost a of each chain has text.
  assert.equal(executeXpath(doc, '//a[1]/text()'), Array(390).fill('x').join('-|-'));
});
