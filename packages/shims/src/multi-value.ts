/**
 * One stored shape for multi-value choice fields (multi select, checkboxes).
 *
 * The Data Store column is text holding a JSON list of the chosen values:
 * `["Yes"]`, `["Red","Blue"]`. Every writer uses this module, so a row reads
 * back the same whichever path wrote it:
 *   - the field-default compiler (a `.ds` `initial value = {"No"}` or `"No"`),
 *     for the submit handler's insert default and the form prefill;
 *   - the runtime write path (a posted list, a Deluge list, or a stored cell);
 *   - migrate-data (an export cell split into its choices).
 *
 * Items are text, trimmed, with empty items dropped. No items is no value
 * (undefined): an empty list is never stored as `[]`, matching migrate-data,
 * which leaves an empty export cell unset. A Deluge list literal (`{"a","b"}`)
 * is never stored as its source text.
 */

/** JSON list text for the given choices, or undefined when no choice remains. */
export function encodeMultiValue(items: readonly unknown[]): string | undefined {
  const list: string[] = [];
  for (const item of items) {
    if (item === null || item === undefined) continue;
    const text = (typeof item === 'string' ? item : String(item)).trim();
    if (text.length > 0) list.push(text);
  }
  return list.length ? JSON.stringify(list) : undefined;
}

/**
 * The items of a static Deluge list literal: `{"a", "b"}`, `{'a'}`, `{}`,
 * `{1, 2}`. A quoted item keeps commas and braces as text; `\"` and a doubled
 * quote are one literal quote. Undefined when the text is not a list literal
 * or an item is not a static literal (an identifier, a call, arithmetic).
 */
export function parseDelugeList(text: string): string[] | undefined {
  const source = text.trim();
  if (source.length < 2 || source[0] !== '{' || source[source.length - 1] !== '}') return undefined;
  const items: string[] = [];
  let i = 1;
  const end = source.length - 1;
  const skipSpace = (): void => {
    while (i < end && /\s/.test(source[i]!)) i++;
  };
  skipSpace();
  if (i === end) return items;
  for (;;) {
    skipSpace();
    const quote = source[i];
    if (quote === '"' || quote === "'") {
      let item = '';
      i++;
      for (;;) {
        if (i >= end) return undefined;
        const ch = source[i]!;
        if (ch === '\\' && i + 1 < end) {
          const next = source[i + 1]!;
          item += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          i += 2;
          continue;
        }
        if (ch === quote) {
          if (source[i + 1] === quote && i + 1 < end) {
            item += quote;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        item += ch;
        i++;
      }
      items.push(item);
    } else {
      const match = /^(?:[+-]?\d+(?:\.\d+)?|true|false)/i.exec(source.slice(i, end));
      if (!match) return undefined;
      items.push(match[0]);
      i += match[0].length;
    }
    skipSpace();
    if (i === end) return items;
    if (source[i] !== ',') return undefined;
    i++;
  }
}

/** True when the text is a Deluge list literal, the shape that must never be stored. */
export function isDelugeListText(value: unknown): boolean {
  return typeof value === 'string' && /^\s*\{[\s\S]*\}\s*$/.test(value);
}

/**
 * The stored default of a multi-value field from its raw `.ds` initial value:
 * a static list literal (`{"No"}`) or one static quoted choice (`"No"`).
 * Undefined for no value, an empty list, or a dynamic expression, so the submit
 * handler never stores expression source as a cell.
 */
export function multiValueDefault(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  const list = parseDelugeList(text);
  if (list) return encodeMultiValue(list);
  if (/^"([^"\\]|\\.|"")*"$/.test(text) || /^'([^'\\]|\\.|'')*'$/.test(text)) {
    const quote = text[0]!;
    const inner = text
      .slice(1, -1)
      .replace(/\\(.)/gs, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c))
      .split(quote + quote)
      .join(quote);
    return encodeMultiValue([inner]);
  }
  return undefined;
}

/**
 * A multi-value cell in its stored shape, for a write: a list (a posted array
 * or a Deluge list) is encoded; JSON list text is re-encoded canonically; a
 * Deluge list literal is parsed; any other text is one choice. An empty or
 * blank value is null. A value of another kind (an object) is returned as is
 * for the store to refuse.
 */
export function multiValueCell(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return encodeMultiValue(value) ?? null;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return encodeMultiValue([value]) ?? null;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return null;
  if (text.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed) && parsed.every((item) => item === null || typeof item !== 'object')) return encodeMultiValue(parsed) ?? null;
  }
  if (isDelugeListText(text)) {
    const list = parseDelugeList(text);
    if (list) return encodeMultiValue(list) ?? null;
  }
  return encodeMultiValue([text]) ?? null;
}
