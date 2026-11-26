/**
 * The one place doctor text is made safe for a terminal or a state file. Every doctor write goes through it: the output sink in
 * `cli.ts` (stdout and stderr), every check detail and fix (`checks.ts`), the values echoed from the environment, and the strings in
 * doctor.json (`report.ts`). A value from a flag, an environment variable, a path, a file, a child process or an error message can carry
 * escape sequences, a carriage return, bidi or zero-width characters, or Unicode tag characters; none of them may reach the output.
 */

/** Invisible and bidi format characters: soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width and direction marks, line/paragraph separators and bidi embeddings, the word-joiner/invisible-operator block, BOM, interlinear annotations, Unicode tag characters. */
const INVISIBLE = '\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb\\u{e0000}-\\u{e007f}';
/** Terminal controls that no output legitimately carries: NUL..BS, VT..US (carriage return, escape), DEL, C1. Tab and newline are separate. */
const CONTROLS = '\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f';

/** Characters that render as nothing or as another character, so a hostile name could pass for a blank or a different value: combining grapheme joiner, Hangul fillers, every other Default_Ignorable_Code_Point and format (Cf) character (Mongolian and Khmer invisibles, musical, Egyptian and shorthand format controls), braille blank, variation selectors (a lone one; see `escapeLookalikes`). They stay recognisable as `\\u{2800}`. */
const LOOKALIKE = '\\u034f\\u115f\\u1160\\u2800\\u3164\\uffa0\\ufe00-\\ufe0f\\u{e0100}-\\u{e01ef}\\p{Default_Ignorable_Code_Point}\\p{Cf}';
/** No-break and other unusual spaces: NBSP, en/em/thin/hair spaces, narrow no-break, medium mathematical, ideographic. They become a plain space. */
const ODD_SPACE = '\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000';

const MULTI_LINE = new RegExp(`[${CONTROLS}${INVISIBLE}]`, 'gu');
const ONE_LINE = new RegExp(`[${CONTROLS}\\t\\n${INVISIBLE}]`, 'gu');
const ODD_SPACES = new RegExp(`[${ODD_SPACE}]`, 'gu');
const LOOKALIKES = new RegExp(`[${LOOKALIKE}]`, 'gu');
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const KEYCAP_BASE = /[0-9#*]/u;

/**
 * U+FE0E and U+FE0F are kept only directly after an emoji base (a pictograph, or a digit, # or * when a combining enclosing keycap follows) and only one per base;
 * any other variation selector is escaped. Every other look-alike is always escaped.
 */
function escapeLookalikes(text: string): string {
  return text.replace(LOOKALIKES, (ch, offset: number, whole: string) => {
    const code = ch.codePointAt(0) as number;
    if (code === 0xfe0e || code === 0xfe0f) {
      const prev = [...whole.slice(Math.max(0, offset - 2), offset)].pop() ?? '';
      if (PICTOGRAPH.test(prev) || (KEYCAP_BASE.test(prev) && whole[offset + 1] === '\u20e3')) return ch;
    }
    return `\\u{${code.toString(16)}}`;
  });
}

function neutralise(text: string, pattern: RegExp): string {
  return escapeLookalikes(text.replace(ODD_SPACES, ' ').replace(pattern, '?'));
}

/** Multi-line output (tables, usage text): newline and tab stay, everything else dangerous becomes '?'. */
export function terminalSafe(text: string): string {
  return neutralise(text, MULTI_LINE);
}

/** A value that must stay on one line (a check detail or fix, an echoed environment value): newline and tab go too, so it can never forge a second line. */
export function singleLine(text: string): string {
  return neutralise(text, ONE_LINE);
}
