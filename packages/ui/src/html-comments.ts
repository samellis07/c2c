/**
 * Where an HTML parser sees a comment in template text that also carries
 * `<% %>` islands. A comment is inert: nothing inside it renders, so a tag
 * written there is no embed to migrate. Only a real comment token counts: a
 * `<!--` inside a tag's attribute value or name, a raw-text element (`script`,
 * `style`, `textarea`, `title` and the like) or an island's string is text, not
 * a comment, and whatever follows it is live.
 *
 * The scan is one linear pass over the HTML tokenizer states that decide this:
 * data, tag and attribute, comment (`-->` and `--!>` both close it, and so do
 * `<!-->` and `<!--->`), bogus comment (`<!x`, `<?x`, `</ x`, `<![CDATA[` up to
 * the next `>`), and raw text with the script's escaped and double-escaped
 * states. An island is skipped whole wherever it stands outside a comment.
 */

/** Elements whose content the tokenizer reads as text up to their own end tag. */
const RAW_TEXT = new Set(['iframe', 'noembed', 'noframes', 'script', 'style', 'textarea', 'title', 'xmp']);

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';
const isAlpha = (c: string | undefined) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

/** The index just past the island that opens at `at` (`<%`, `<%=` or `<%{`), or the end of the text when it never closes. */
function islandEnd(source: string, at: number): number {
  if (source.startsWith('<%{', at)) {
    const brace = source.indexOf('%}', at + 3);
    const plain = source.indexOf('%>', at + 3);
    if (brace < 0 && plain < 0) return source.length;
    return brace >= 0 && (plain < 0 || brace < plain) ? brace + (source.startsWith('%}>', brace) ? 3 : 2) : plain + 2;
  }
  const end = source.indexOf('%>', at + 2);
  return end < 0 ? source.length : end + 2;
}

const startsWithFold = (source: string, at: number, word: string) => source.slice(at, at + word.length).toLowerCase() === word;
const endsName = (c: string | undefined) => c === undefined || isSpace(c) || c === '/' || c === '>';

/** The index just past the `>` that closes the tag whose name ends at `at`, or the end of the text. */
function tagEnd(source: string, start: number): number {
  let at = start;
  while (at < source.length) {
    const c = source[at]!;
    if (source.startsWith('<%', at)) at = islandEnd(source, at);
    else if (c === '>') return at + 1;
    else if (isSpace(c) || c === '/') at++;
    else {
      // An attribute name (its first character may be `=`), then an optional value.
      at++;
      while (at < source.length && !isSpace(source[at]) && source[at] !== '/' && source[at] !== '>' && source[at] !== '=') {
        at = source.startsWith('<%', at) ? islandEnd(source, at) : at + 1;
      }
      while (isSpace(source[at])) at++;
      if (source[at] !== '=') continue;
      at++;
      while (isSpace(source[at])) at++;
      const quote = source[at];
      if (quote === '"' || quote === "'") {
        at++;
        while (at < source.length && source[at] !== quote) at = source.startsWith('<%', at) ? islandEnd(source, at) : at + 1;
        at++;
      } else {
        while (at < source.length && !isSpace(source[at]) && source[at] !== '>') at = source.startsWith('<%', at) ? islandEnd(source, at) : at + 1;
      }
    }
  }
  return source.length;
}

/** Where the raw text of `name` ends: the start of its end tag, or the end of the text. */
function rawTextEnd(source: string, start: number, name: string): number {
  // The script's escaped state (`<!--`) hides its own end tag from a nested
  // `<script`, and `-->` leaves it again.
  let state: 'data' | 'escaped' | 'double' = 'data';
  let at = start;
  while (at < source.length) {
    if (source.startsWith('<%', at)) {
      at = islandEnd(source, at);
      continue;
    }
    if (source.startsWith('</', at) && startsWithFold(source, at + 2, name) && endsName(source[at + 2 + name.length])) {
      if (state !== 'double') return at;
      state = 'escaped';
      at += 2 + name.length;
      continue;
    }
    if (name === 'script') {
      if (state === 'data' && source.startsWith('<!--', at)) {
        // The two dashes of `<!--` can already close it: `<!-->`, `<!--->`.
        state = 'escaped';
        at += 2;
        continue;
      }
      if (state !== 'data' && source.startsWith('-->', at)) {
        state = 'data';
        at += 3;
        continue;
      }
      if (state === 'escaped' && source.charAt(at) === '<' && startsWithFold(source, at + 1, 'script') && endsName(source[at + 7])) {
        state = 'double';
        at += 7;
        continue;
      }
    }
    at++;
  }
  return source.length;
}

/** The index just past the comment that opens at `at` (`<!--`), or the end of the text when it never closes. */
function commentEnd(source: string, at: number): number {
  for (let n = at + 2; n < source.length; n++) {
    if (source.startsWith('-->', n)) return n + 3;
    if (n >= at + 4 && source.startsWith('--!>', n)) return n + 4;
  }
  return source.length;
}

/** The `[start, end)` spans of `source` the HTML tokenizer reads as comments, in order. */
export function htmlCommentRanges(source: string): [number, number][] {
  const ranges: [number, number][] = [];
  const bogus = (at: number) => {
    const close = source.indexOf('>', at);
    return close < 0 ? source.length : close + 1;
  };
  let at = 0;
  while (at < source.length) {
    at = source.indexOf('<', at);
    if (at < 0) break;
    const next = source[at + 1];
    if (next === '%') {
      at = islandEnd(source, at);
    } else if (source.startsWith('<!--', at)) {
      const end = commentEnd(source, at);
      ranges.push([at, end]);
      at = end;
    } else if (next === '!' || next === '?' || (next === '/' && !isAlpha(source[at + 2]) && source[at + 2] !== '>')) {
      // A doctype is no comment; every other `<!`, `<?` and `</` + non-letter is one up to the next `>`.
      const end = bogus(at + 2);
      if (!(next === '!' && startsWithFold(source, at + 2, 'doctype'))) ranges.push([at, end]);
      at = end;
    } else if (isAlpha(next) || (next === '/' && isAlpha(source[at + 2]))) {
      const nameStart = at + (next === '/' ? 2 : 1);
      let nameEnd = nameStart;
      while (nameEnd < source.length && !endsName(source[nameEnd]) && !source.startsWith('<%', nameEnd)) nameEnd++;
      const name = source.slice(nameStart, nameEnd).toLowerCase();
      at = tagEnd(source, nameEnd);
      if (next !== '/' && name === 'plaintext') break;
      if (next !== '/' && RAW_TEXT.has(name)) at = rawTextEnd(source, at, name);
    } else {
      at++;
    }
  }
  return ranges;
}

/** Whether `offset` falls inside one of the ordered `ranges`. */
export function inRanges(ranges: readonly (readonly [number, number])[], offset: number): boolean {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid]!;
    if (offset < start) hi = mid - 1;
    else if (offset >= end) lo = mid + 1;
    else return true;
  }
  return false;
}
