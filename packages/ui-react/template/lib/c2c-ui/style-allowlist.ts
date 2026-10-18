const STYLE_TEXT_MAX = 8192;
const CALC_ARGS_MAX = 200;

const STYLE_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'rotate', 'rotatex', 'rotatey', 'rotatez', 'hue-rotate', 'scale', 'scalex', 'scaley',
  'translate', 'translatex', 'translatey', 'skew', 'skewx', 'skewy',
]);

const STYLE_ARGS = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|[a-z]{1,4})?(?:(?:\s*[,/]\s*|\s+)[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:%|[a-z]{1,4})?)*\s*$/i;

function flatCss(value: string): string {
  return String(value ?? '').replace(/[\u0000-\u0020]+/g, '').toLowerCase();
}

function asciiLetter(ch: string): boolean {
  const c = ch.charCodeAt(0) | 32;
  return c >= 97 && c <= 122;
}

function calcArgsSafe(args: string): boolean {
  const text = String(args ?? '');
  const n = text.length;
  if (n === 0 || n > CALC_ARGS_MAX) return false;
  let i = 0;
  const spaces = () => { while (i < n && /\s/.test(text[i]!)) i++; };
  const number = () => {
    if (text[i] === '+' || text[i] === '-') i++;
    let whole = 0;
    while (i < n && text[i]! >= '0' && text[i]! <= '9') { i++; whole++; }
    let frac = 0;
    if (text[i] === '.') {
      i++;
      while (i < n && text[i]! >= '0' && text[i]! <= '9') { i++; frac++; }
    }
    return whole > 0 || frac > 0;
  };
  const unit = () => {
    if (text[i] === '%') { i++; return true; }
    let letters = 0;
    while (i < n && asciiLetter(text[i]!)) { i++; letters++; }
    return letters <= 4;
  };
  spaces();
  if (!number() || !unit()) return false;
  for (;;) {
    spaces();
    if (i >= n) return true;
    const op = text[i]!;
    if (op !== '+' && op !== '-' && op !== '*' && op !== '/') return false;
    i++;
    spaces();
    if (!number() || !unit()) return false;
  }
}

function replaceStyleCalls(text: string, decide: (name: string, args: string) => string): string {
  const nameChar = (ch: string) => ch === '-' || (ch >= '0' && ch <= '9') || asciiLetter(ch);
  let out = '';
  let i = 0;
  const n = text.length;
  let from = 0;
  while (from < n) {
    const open = text.indexOf('(', from);
    if (open < 0) break;
    let nameStart = open;
    while (nameStart > i && nameChar(text[nameStart - 1]!)) nameStart--;
    let close = open + 1;
    while (close < n && text[close]! !== '(' && text[close]! !== ')') close++;
    if (close >= n || text[close]! === '(') {
      from = open + 1;
      continue;
    }
    out += text.slice(i, nameStart) + decide(text.slice(nameStart, open), text.slice(open + 1, close));
    i = close + 1;
    from = i;
  }
  return out + text.slice(i);
}

export function isSafeStyleProperty(name: string): boolean {
  const prop = String(name ?? '').trim().toLowerCase();
  return /^-?[-a-z]+$/.test(prop) && prop !== 'behavior' && prop !== '-moz-binding';
}

export function isSafeStyleValue(raw: string, prop?: string): boolean {
  let text = String(raw ?? '').trim();
  if (!text || text.length > STYLE_TEXT_MAX || /[;\\@<>]/.test(text) || text.includes('/*')) return false;
  if (prop === 'font-family') text = text.replace(/"[A-Za-z0-9 _-]*"|'[A-Za-z0-9 _-]*'/g, 'x');
  if (/['"]/.test(text)) return false;
  const flat = flatCss(text);
  if (flat.includes('url(') || flat.includes('expression')) return false;
  const rest = replaceStyleCalls(text, (name, args) => {
    const fn = name.toLowerCase();
    if (STYLE_FUNCTIONS.has(fn) && STYLE_ARGS.test(args)) return ' ';
    if (fn === 'calc' && calcArgsSafe(args)) return ' ';
    return '(';
  });
  return !/[()]/.test(rest);
}

export { STYLE_TEXT_MAX };
