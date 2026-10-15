/**
 * Deluge XML builtins.
 *
 * - toXml — https://www.zoho.com/deluge/help/functions/xml/toxml.html
 *   JSON object text, or Deluge `{key:value}` map text, becomes an XML
 *   document whose root is `<root>`. An array value is repeated sibling
 *   elements of that key. Keys stay in source order. Null, a top-level
 *   array, and a key that is not an XML name throw.
 * - executeXpath — https://www.zoho.com/deluge/help/xml-manipulation/executexpath.html
 *   XML text, or the same JSON/map text (address it under `/root`), selected
 *   by an absolute path. An element result is that element. Several elements
 *   are concatenated. An attribute result is `<name>value</name>`. `text()`
 *   is the decoded character data; several text nodes join with `-|-`.
 *   A path the subset cannot express, or a path that is not absolute, throws.
 *   No match is `""`.
 * - toXmlList — https://www.zoho.com/deluge/help/functions/xml/toxmllist.html
 *   Top-level elements of an XML fragment (the usual executeXpath result)
 *   become a list of one XML string each. Whitespace between them is ignored.
 *
 * The parser accepts only the five predefined entities and numeric character
 * references. A DOCTYPE, a custom entity, or any external identifier throws
 * before a name is resolved, so there is no network fetch and no XXE.
 */

import { DelugeConversionError } from './convert.js';
import { Decimal } from './decimal.js';
import { DelugeRuntimeError } from './errors.js';
import { parseJsonLossless } from './ids.js';

const MAX_TEXT = 5 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_DEPTH = 256;

const XML_NAME = /^[:A-Za-z_][:A-Za-z0-9._-]*$/;
const XML_NAME_AT = /^[:A-Za-z_][:A-Za-z0-9._-]*/;

type El = {
  kind: 'el';
  id: number;
  name: string;
  attrs: Attr[];
  children: Array<El | Text>;
};
type Text = { kind: 'text'; id: number; value: string };
type Attr = { kind: 'attr'; id: number; name: string; value: string };
type Doc = { kind: 'doc'; children: Array<El | Text> };
type Node = El | Text | Attr | Doc;

type Op = '=' | '!=' | '<' | '>' | '<=' | '>=';
type Literal = { kind: 'string'; value: string } | { kind: 'number'; value: number };
type Pred =
  | { kind: 'pos'; n: number }
  | { kind: 'cmp'; attr: boolean; name: string; op: Op; right: Literal };
type Step = {
  descendant: boolean;
  axis: 'child' | 'attribute' | 'text';
  name: string;
  predicates: Pred[];
};

export function toXml(value: unknown, ...extra: unknown[]): string {
  if (extra.length) throw new DelugeConversionError('toXml() takes no arguments');
  const data = asMap(value);
  let nodes = 0;
  const bump = () => {
    if (++nodes > MAX_NODES) throw new DelugeConversionError('toXml: value exceeds the node limit');
  };
  return `<root>${emitObject(data, bump)}</root>`;
}

export function toXmlList(value: unknown, ...extra: unknown[]): string[] {
  if (extra.length) throw new DelugeConversionError('toXmlList() takes no arguments');
  if (typeof value !== 'string') throw new DelugeConversionError('toXmlList: text is not XML');
  const doc = parseXml(value);
  const elements: El[] = [];
  for (const child of doc.children) {
    if (child.kind === 'el') elements.push(child);
    else if (child.value.trim() !== '') throw new DelugeConversionError('toXmlList: text is not XML');
  }
  if (!elements.length) throw new DelugeConversionError('toXmlList: text is not XML');
  return elements.map(serializeEl);
}

export function executeXpath(value: unknown, xpath?: unknown, ...extra: unknown[]): string {
  if (extra.length || typeof xpath !== 'string' || xpath.trim() === '') throw new DelugeRuntimeError('Invalid Xpath');
  if (typeof value !== 'string') throw new DelugeRuntimeError('executeXpath: text is not XML or JSON');
  const text = stripBom(value);
  const trimmed = text.trim();
  if (!trimmed) throw new DelugeRuntimeError('executeXpath: text is not XML or JSON');
  const doc = trimmed.startsWith('{') ? parseXml(toXml(text)) : trimmed.startsWith('<') ? parseXml(text) : null;
  if (!doc) throw new DelugeRuntimeError('executeXpath: text is not XML or JSON');
  const selected = evalPath(doc, parsePath(xpath));
  return renderSelection(selected);
}

function asMap(value: unknown): Record<string, unknown> {
  if (isPlain(value)) return value;
  if (typeof value !== 'string') throw new DelugeConversionError('toXml: text is not JSON or map text');
  if (value.length > MAX_TEXT) throw new DelugeConversionError('toXml: text exceeds 5 MB');
  const text = stripBom(value).trim();
  if (!text.startsWith('{')) throw new DelugeConversionError('toXml: text is not JSON or map text');
  try {
    const parsed = parseJsonLossless(text);
    if (isPlain(parsed)) return parsed;
  } catch {
    /* Deluge {key:value} text is not JSON. */
  }
  return parseLooseMap(text);
}

function emitObject(data: Record<string, unknown>, bump: () => void): string {
  let out = '';
  for (const key of Object.keys(data)) {
    if (!XML_NAME.test(key)) throw new DelugeConversionError('toXml: key is not an XML name');
    out += emitValue(data[key], key, bump);
  }
  return out;
}

function emitValue(value: unknown, key: string, bump: () => void): string {
  if (Array.isArray(value)) {
    let out = '';
    for (const item of value) {
      if (Array.isArray(item)) throw new DelugeConversionError('toXml: nested array has no element name');
      out += emitValue(item, key, bump);
    }
    return out;
  }
  bump();
  if (value == null) throw new DelugeConversionError('toXml: null has no XML representation');
  if (isPlain(value)) return `<${key}>${emitObject(value, bump)}</${key}>`;
  return `<${key}>${escapeText(formatScalar(value))}</${key}>`;
}

function formatScalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Decimal) return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DelugeConversionError('toXml: number is not finite');
    if (Object.is(value, -0)) return '0';
    return String(value);
  }
  throw new DelugeConversionError('toXml: value cannot be written as XML');
}

function parseLooseMap(text: string): Record<string, unknown> {
  const p = new Loose(text);
  const value = p.parseValue();
  p.skip();
  if (!p.done() || !isPlain(value)) throw new DelugeConversionError('toXml: text is not JSON or map text');
  return value;
}

class Loose {
  private i = 0;

  constructor(private readonly s: string) {}

  done(): boolean {
    return this.i >= this.s.length;
  }

  skip(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  private peek(): string {
    return this.s[this.i] ?? '';
  }

  private eat(ch: string): void {
    this.skip();
    if (this.peek() !== ch) throw new DelugeConversionError('toXml: text is not JSON or map text');
    this.i++;
  }

  parseValue(): unknown {
    this.skip();
    const c = this.peek();
    if (c === '{') return this.parseObject();
    if (c === '[') return this.parseArray();
    if (c === '"' || c === "'") return this.parseString();
    if (c === '-' || (c >= '0' && c <= '9')) return this.parseNumber();
    const ident = this.parseIdent();
    if (ident === 'true') return true;
    if (ident === 'false') return false;
    if (ident === 'null') return null;
    if (!ident) throw new DelugeConversionError('toXml: text is not JSON or map text');
    return ident;
  }

  private parseObject(): Record<string, unknown> {
    this.eat('{');
    const out: Record<string, unknown> = {};
    this.skip();
    if (this.peek() === '}') {
      this.i++;
      return out;
    }
    while (this.i < this.s.length) {
      const key = this.parseKey();
      this.eat(':');
      setOwn(out, key, this.parseValue());
      this.skip();
      if (this.peek() === ',') {
        this.i++;
        this.skip();
        if (this.peek() === '}') throw new DelugeConversionError('toXml: text is not JSON or map text');
        continue;
      }
      this.eat('}');
      return out;
    }
    throw new DelugeConversionError('toXml: text is not JSON or map text');
  }

  private parseArray(): unknown[] {
    this.eat('[');
    const out: unknown[] = [];
    this.skip();
    if (this.peek() === ']') {
      this.i++;
      return out;
    }
    while (this.i < this.s.length) {
      out.push(this.parseValue());
      this.skip();
      if (this.peek() === ',') {
        this.i++;
        this.skip();
        if (this.peek() === ']') throw new DelugeConversionError('toXml: text is not JSON or map text');
        continue;
      }
      this.eat(']');
      return out;
    }
    throw new DelugeConversionError('toXml: text is not JSON or map text');
  }

  private parseKey(): string {
    this.skip();
    if (this.peek() === '"' || this.peek() === "'") return this.parseString();
    const key = this.parseIdent();
    if (!key) throw new DelugeConversionError('toXml: text is not JSON or map text');
    return key;
  }

  private parseIdent(): string {
    this.skip();
    const start = this.i;
    if (!/[:A-Za-z_]/.test(this.peek())) return '';
    this.i++;
    while (/[A-Za-z0-9_]/.test(this.peek())) this.i++;
    return this.s.slice(start, this.i);
  }

  private parseString(): string {
    const quote = this.peek();
    this.i++;
    let out = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === '\\') {
        out += this.s[this.i + 1] ?? '';
        this.i += 2;
        continue;
      }
      if (c === quote) {
        this.i++;
        return out;
      }
      out += c;
      this.i++;
    }
    throw new DelugeConversionError('toXml: text is not JSON or map text');
  }

  private parseNumber(): number | string {
    this.skip();
    const start = this.i;
    if (this.peek() === '-' || this.peek() === '+') this.i++;
    const body = this.i;
    while (this.peek() >= '0' && this.peek() <= '9') this.i++;
    if (this.peek() === '.') {
      this.i++;
      while (this.peek() >= '0' && this.peek() <= '9') this.i++;
    }
    if (this.i === body || this.peek() === 'e' || this.peek() === 'E') {
      throw new DelugeConversionError('toXml: text is not JSON or map text');
    }
    const token = this.s.slice(start, this.i).replace(/^\+/, '');
    if (/^-?\d+$/.test(token)) {
      if (!Number.isSafeInteger(Number(token))) return token;
      return Number(token);
    }
    const n = Number(token);
    if (Number.isFinite(n) && String(n) === token) return n;
    return token;
  }
}

function parseXml(input: string): Doc {
  const text = stripBom(input);
  if (text.length > MAX_TEXT) throw new DelugeRuntimeError('XML exceeds 5 MB');
  if (illegalXmlChar(text)) throw new DelugeRuntimeError('XML is not well-formed');
  const doc: Doc = { kind: 'doc', children: [] };
  const stack: El[] = [];
  let i = 0;
  let nextId = 1;
  let nodes = 0;
  const parent = (): Doc | El => (stack.length ? stack[stack.length - 1]! : doc);
  const bump = (): number => {
    if (++nodes > MAX_NODES) throw new DelugeRuntimeError('XML exceeds the node limit');
    return nextId++;
  };
  const addText = (value: string) => {
    if (!value) return;
    const p = parent();
    const last = p.children[p.children.length - 1];
    if (last && last.kind === 'text') {
      last.value += value;
      return;
    }
    p.children.push({ kind: 'text', id: bump(), value });
  };

  while (i < text.length) {
    if (text[i] !== '<') {
      const start = i;
      while (i < text.length && text[i] !== '<') i++;
      addText(xmlText(text.slice(start, i)));
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) throw new DelugeRuntimeError('XML is not well-formed');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) throw new DelugeRuntimeError('XML is not well-formed');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end < 0) throw new DelugeRuntimeError('XML is not well-formed');
      addText(normalizeNewlines(text.slice(i + 9, end)));
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', i)) throw new DelugeRuntimeError('DOCTYPE is not allowed');
    if (text.startsWith('</', i)) {
      i += 2;
      const name = readXmlName(text, i);
      i = name.end;
      if (text[i] !== '>') throw new DelugeRuntimeError('XML is not well-formed');
      i++;
      const open = stack.pop();
      if (!open || open.name !== name.value) throw new DelugeRuntimeError('XML is not well-formed');
      continue;
    }
    i++;
    const name = readXmlName(text, i);
    i = name.end;
    const el: El = { kind: 'el', id: bump(), name: name.value, attrs: [], children: [] };
    const seen = new Set<string>();
    let closed = false;
    while (i < text.length) {
      const before = i;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text.startsWith('/>', i)) {
        i += 2;
        closed = true;
        break;
      }
      if (text[i] === '>') {
        i++;
        break;
      }
      if (i === before) throw new DelugeRuntimeError('XML is not well-formed');
      const attr = readXmlName(text, i);
      i = attr.end;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text[i] !== '=') throw new DelugeRuntimeError('XML is not well-formed');
      i++;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      const quote = text[i];
      if (quote !== '"' && quote !== "'") throw new DelugeRuntimeError('XML is not well-formed');
      const end = text.indexOf(quote, i + 1);
      if (end < 0) throw new DelugeRuntimeError('XML is not well-formed');
      if (seen.has(attr.value)) throw new DelugeRuntimeError('XML is not well-formed');
      seen.add(attr.value);
      el.attrs.push({ kind: 'attr', id: bump(), name: attr.value, value: xmlText(text.slice(i + 1, end)) });
      i = end + 1;
    }
    parent().children.push(el);
    if (!closed) {
      if (stack.length >= MAX_DEPTH) throw new DelugeRuntimeError('XML exceeds the depth limit');
      stack.push(el);
    }
  }
  if (stack.length) throw new DelugeRuntimeError('XML is not well-formed');
  return doc;
}

function readXmlName(text: string, i: number): { value: string; end: number } {
  const m = XML_NAME_AT.exec(text.slice(i));
  if (!m || m.index !== 0) throw new DelugeRuntimeError('XML is not well-formed');
  return { value: m[0], end: i + m[0].length };
}

function xmlText(raw: string): string {
  return normalizeNewlines(decodeEntities(raw));
}

function decodeEntities(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '&') {
      out += raw[i];
      continue;
    }
    const semi = raw.indexOf(';', i + 1);
    if (semi < 0 || semi - i > 16) throw new DelugeRuntimeError('XML entity is not allowed');
    out += entityChar(raw.slice(i + 1, semi));
    i = semi;
  }
  if (illegalXmlChar(out)) throw new DelugeRuntimeError('XML is not well-formed');
  return out;
}

function entityChar(body: string): string {
  if (body === 'amp') return '&';
  if (body === 'lt') return '<';
  if (body === 'gt') return '>';
  if (body === 'quot') return '"';
  if (body === 'apos') return "'";
  const hex = /^#x([0-9A-Fa-f]+)$/.exec(body);
  const dec = /^#([0-9]+)$/.exec(body);
  const digits = hex?.[1] ?? dec?.[1];
  if (!digits) throw new DelugeRuntimeError('XML entity is not allowed');
  const cp = Number.parseInt(digits, hex ? 16 : 10);
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) throw new DelugeRuntimeError('XML is not well-formed');
  const ch = String.fromCodePoint(cp);
  if (illegalXmlChar(ch)) throw new DelugeRuntimeError('XML is not well-formed');
  return ch;
}

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

function illegalXmlChar(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x9 || c === 0xa || c === 0xd) continue;
    if (c >= 0x20 && c <= 0xd7ff) continue;
    if (c >= 0xe000 && c <= 0xfffd) continue;
    if (c >= 0x10000 && c <= 0x10ffff) continue;
    return true;
  }
  return false;
}

function parsePath(path: string): Step[] {
  const s = path.trim();
  if (!s.startsWith('/')) throw new DelugeRuntimeError('Invalid Xpath');
  const steps: Step[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '/') throw new DelugeRuntimeError('Invalid Xpath');
    i++;
    const descendant = s[i] === '/';
    if (descendant) i++;
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length || s[i] === '/') throw new DelugeRuntimeError('Invalid Xpath');
    let axis: Step['axis'] = 'child';
    let name = '';
    if (s.startsWith('text()', i)) {
      axis = 'text';
      i += 6;
    } else if (s[i] === '@') {
      axis = 'attribute';
      i++;
      const read = readPathName(s, i);
      name = read.value;
      i = read.end;
    } else if (s[i] === '*') {
      name = '*';
      i++;
    } else {
      const read = readPathName(s, i);
      name = read.value;
      i = read.end;
    }
    const predicates: Pred[] = [];
    while (i < s.length && /\s/.test(s[i]!)) i++;
    while (s[i] === '[') {
      const pred = readPredicate(s, i);
      predicates.push(pred.pred);
      i = pred.end;
      while (i < s.length && /\s/.test(s[i]!)) i++;
    }
    steps.push({ descendant, axis, name, predicates });
  }
  if (!steps.length) throw new DelugeRuntimeError('Invalid Xpath');
  return steps;
}

function readPathName(s: string, i: number): { value: string; end: number } {
  const m = XML_NAME_AT.exec(s.slice(i));
  if (!m || m.index !== 0) throw new DelugeRuntimeError('Invalid Xpath');
  return { value: m[0], end: i + m[0].length };
}

function readPredicate(s: string, i: number): { pred: Pred; end: number } {
  i++;
  let quote: string | null = null;
  const start = i;
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ']') break;
  }
  if (s[i] !== ']' || quote) throw new DelugeRuntimeError('Invalid Xpath');
  return { pred: parsePred(s.slice(start, i).trim()), end: i + 1 };
}

function parsePred(body: string): Pred {
  if (/^\d+$/.test(body)) return { kind: 'pos', n: Number(body) };
  const m = /^(@?)([:A-Za-z_][:A-Za-z0-9._-]*)\s*(<=|>=|!=|=|<|>)\s*([\s\S]+)$/.exec(body);
  if (!m) throw new DelugeRuntimeError('Invalid Xpath');
  return { kind: 'cmp', attr: m[1] === '@', name: m[2]!, op: m[3] as Op, right: parseLiteral(m[4]!.trim()) };
}

function parseLiteral(raw: string): Literal {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return { kind: 'string', value: raw.slice(1, -1).replace(/\\(.)/g, '$1') };
  }
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return { kind: 'number', value: Number(raw) };
  if (XML_NAME.test(raw)) return { kind: 'string', value: raw };
  throw new DelugeRuntimeError('Invalid Xpath');
}

function evalPath(doc: Doc, steps: Step[]): Array<El | Text | Attr> {
  let current: Array<El | Text | Attr | Doc> = [doc];
  for (const step of steps) {
    const found: Array<El | Text | Attr> = [];
    for (const node of current) found.push(...stepNodes(node, step));
    let selected = dedupe(found);
    for (const pred of step.predicates) selected = applyPred(selected, pred);
    current = selected;
  }
  return current as Array<El | Text | Attr>;
}

function stepNodes(node: Node, step: Step): Array<El | Text | Attr> {
  const hosts: Array<Doc | El> = [];
  if (step.descendant) {
    if (node.kind === 'doc') hosts.push(node, ...descendantEls(node));
    else if (node.kind === 'el') hosts.push(node, ...descendantEls(node));
  } else if (node.kind === 'doc' || node.kind === 'el') {
    hosts.push(node);
  }
  const out: Array<El | Text | Attr> = [];
  for (const host of hosts) {
    if (step.axis === 'attribute') {
      if (host.kind !== 'el') continue;
      for (const attr of host.attrs) if (step.name === '*' || attr.name === step.name) out.push(attr);
      continue;
    }
    if (step.axis === 'text') {
      for (const child of host.children) if (child.kind === 'text') out.push(child);
      continue;
    }
    for (const child of host.children) {
      if (child.kind === 'el' && (step.name === '*' || child.name === step.name)) out.push(child);
    }
  }
  return out;
}

function descendantEls(node: Doc | El): El[] {
  const out: El[] = [];
  for (const child of node.children) {
    if (child.kind !== 'el') continue;
    out.push(child, ...descendantEls(child));
  }
  return out;
}

function applyPred(nodes: Array<El | Text | Attr>, pred: Pred): Array<El | Text | Attr> {
  if (pred.kind === 'pos') return pred.n >= 1 && pred.n <= nodes.length ? [nodes[pred.n - 1]!] : [];
  return nodes.filter((node) => comparePred(node, pred));
}

function comparePred(node: El | Text | Attr, pred: Extract<Pred, { kind: 'cmp' }>): boolean {
  if (node.kind !== 'el') return false;
  const values = pred.attr
    ? node.attrs.filter((attr) => attr.name === pred.name).map((attr) => attr.value)
    : node.children.filter((child): child is El => child.kind === 'el' && child.name === pred.name).map(stringValue);
  if (!values.length) return false;
  return values.some((value) => compareValue(value, pred.op, pred.right));
}

function compareValue(left: string, op: Op, right: Literal): boolean {
  if (op === '=' || op === '!=') {
    const same = right.kind === 'number' ? numeric(left) === right.value : left === right.value;
    return op === '=' ? same : !same;
  }
  const ln = numeric(left);
  const rn = right.kind === 'number' ? right.value : numeric(right.value);
  if (ln == null || rn == null) return false;
  if (op === '<') return ln < rn;
  if (op === '>') return ln > rn;
  if (op === '<=') return ln <= rn;
  return ln >= rn;
}

function numeric(value: string): number | null {
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

function stringValue(node: El | Text | Attr): string {
  if (node.kind !== 'el') return node.value;
  let out = '';
  const walk = (n: El | Text) => {
    if (n.kind === 'text') out += n.value;
    else for (const child of n.children) walk(child);
  };
  walk(node);
  return out;
}

function renderSelection(nodes: Array<El | Text | Attr>): string {
  if (!nodes.length) return '';
  if (nodes.every((node) => node.kind === 'text')) return nodes.map((node) => (node as Text).value).join('-|-');
  if (nodes.every((node) => node.kind === 'attr')) {
    return nodes.map((node) => `<${(node as Attr).name}>${escapeText((node as Attr).value)}</${(node as Attr).name}>`).join('');
  }
  if (nodes.every((node) => node.kind === 'el')) return nodes.map((node) => serializeEl(node as El)).join('');
  throw new DelugeRuntimeError('Invalid Xpath');
}

function serializeEl(el: El): string {
  const attrs = el.attrs.map((attr) => ` ${attr.name}="${escapeAttr(attr.value)}"`).join('');
  const inner = el.children.map((child) => (child.kind === 'text' ? escapeText(child.value) : serializeEl(child))).join('');
  return `<${el.name}${attrs}>${inner}</${el.name}>`;
}

function dedupe(nodes: Array<El | Text | Attr>): Array<El | Text | Attr> {
  const seen = new Set<number>();
  const out: Array<El | Text | Attr> = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value instanceof Decimal) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
