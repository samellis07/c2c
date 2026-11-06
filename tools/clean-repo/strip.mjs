/**
 * Compile and apply the replace-msg rules in replace-msg.txt. Shared by
 * cutover.mjs (which rewrites a fast-export stream) and the tests; kept
 * separate so the rules file stays the single source of truth.
 *
 * Rule line grammar (git filter-repo --replace-msg):
 *   regex:<pattern>==><replacement>
 *   literal:<text>==><replacement>
 *   glob:<pattern>==><replacement>
 * A leading `(?m)` / `(?s)` in a regex maps to the m / s flag.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INLINE_FLAGS = /^\(\?([ms])\)/;

function escapeLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(glob) {
  return glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
}

export function loadRules(file = fileURLToPath(new URL('./replace-msg.txt', import.meta.url))) {
  const rules = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trimEnd();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf('==>');
    const head = sep === -1 ? line : line.slice(0, sep);
    const replacement = sep === -1 ? '***REMOVED***' : line.slice(sep + 3);
    const kind = head.slice(0, head.indexOf(':'));
    let pattern = head.slice(kind.length + 1);
    let flags = 'g';
    if (kind === 'regex') {
      const m = INLINE_FLAGS.exec(pattern);
      if (m) {
        if (m[1].includes('m')) flags += 'm';
        if (m[1].includes('s')) flags += 's';
        pattern = pattern.slice(m[0].length);
      }
    } else if (kind === 'literal') {
      pattern = escapeLiteral(pattern);
    } else if (kind === 'glob') {
      pattern = globToRegex(pattern);
    } else {
      throw new Error(`replace-msg: unknown rule kind in line: ${line}`);
    }
    rules.push({ re: new RegExp(pattern, flags), replacement });
  }
  return rules;
}

/**
 * Apply every rule to one commit or tag message, then tidy: no trailing
 * whitespace per line, no more than one blank line in a row, and the message
 * ends with a single newline.
 */
export function stripMessage(message, rules) {
  let out = message;
  for (const rule of rules) out = out.replace(rule.re, rule.replacement);
  const trimmed = out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
  return trimmed ? `${trimmed}\n` : '';
}

/**
 * Patterns the rewritten history must never contain. Kept independent of
 * replace-msg.txt on purpose: if a rule is missing or wrong, the cutover's
 * self-check still catches the survivor. Each line-oriented pattern is
 * anchored to a line start so prose that merely names a tool mid-sentence
 * is kept.
 */
export const VENDOR_TRAILER_CHECKS = [
  { name: 'Claude-Session trailer', re: /^[ \t]*claude-session:/im },
  { name: 'agent session trailer', re: /^[ \t]*[a-z]+-session:[ \t]*https?:\/\//im },
  { name: 'agent session URL', re: /claude\.ai\/code\/session_/i },
  { name: 'Co-Authored-By trailer', re: /^[ \t]*co-authored-by:/im },
  { name: '"Generated with" footer', re: /^[ \t]*(🤖[ \t]*)?generated (with|by) (\[|claude|copilot|cursor|gemini|aider|chatgpt)/im },
  // A whole line naming one tool, the shape `Generated with <Name>`.
  // Case-sensitive so a sentence is not a footer.
  { name: 'bare generated-with footer', re: /^[ \t]*Generated (with|by) [A-Z][A-Za-z0-9.+_-]*\.?[ \t]*$/m },
  { name: 'robot-emoji trailer', re: /^[ \t]*🤖/mu },
  { name: 'bot signed-off-by trailer', re: /^[ \t]*signed-off-by:[^\n]*\[bot\]/im },
];

/** Names of every VENDOR_TRAILER_CHECKS pattern that matches `message`. */
export function vendorTrailerHits(message) {
  return VENDOR_TRAILER_CHECKS.filter((c) => c.re.test(message)).map((c) => c.name);
}
