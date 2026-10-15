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
