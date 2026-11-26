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

const MULTI_LINE = new RegExp(`[${CONTROLS}${INVISIBLE}]`, 'gu');
const ONE_LINE = new RegExp(`[${CONTROLS}\\t\\n${INVISIBLE}]`, 'gu');

/** Multi-line output (tables, usage text): newline and tab stay, everything else dangerous becomes '?'. */
export function terminalSafe(text: string): string {
  return text.replace(MULTI_LINE, '?');
}

/** A value that must stay on one line (a check detail or fix, an echoed environment value): newline and tab go too, so it can never forge a second line. */
export function singleLine(text: string): string {
  return text.replace(ONE_LINE, '?');
}
