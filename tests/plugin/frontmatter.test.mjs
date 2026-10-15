/**
 * Plugin frontmatter and references lint.
 *
 * - Every plugin/commands/*.md has YAML frontmatter with a non-empty
 *   description, and any allowed-tools entry is well-formed.
 * - Every plugin/skills/[dir]/SKILL.md has name == its directory name and a
 *   description of at most 1024 chars with no angle brackets.
 * - Every skill and command that cites a references/ file points to a file that exists.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginDir = path.join(repo, 'plugin');
const commandsDir = path.join(pluginDir, 'commands');
const skillsDir = path.join(pluginDir, 'skills');

/**
 * Split leading `---` YAML frontmatter from the body.
 * Returns { fm, body }. If no frontmatter block is found, fm is null.
 */
export function splitFrontmatter(text) {
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) return { fm: null, body: text };
  return { fm: match[1], body: text.slice(match[0].length) };
}

/** Strip matching surrounding double or single quotes. */
export function stripQuotes(str) {
  if (typeof str !== 'string') return str;
  str = str.trim();
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1);
  }
  return str;
}

/**
 * Minimal YAML frontmatter parser for plugin commands and skills.
 * Handles top-level key-value pairs, quoted strings, block scalars,
 * and inline/multiline lists.
 */
export function parseFrontmatter(fmText) {
  if (fmText == null) return null;
  const lines = fmText.split(/\r?\n/);
  const result = {};
  let currentKey = null;
  let currentMode = null; // 'block-scalar' | 'list' | null
  let blockLines = [];
  let listItems = [];

  function flush() {
    if (!currentKey) return;
    if (currentMode === 'block-scalar') {
      result[currentKey] = blockLines.join('\n').trim();
    } else if (currentMode === 'list') {
      result[currentKey] = listItems;
    }
    currentKey = null;
    currentMode = null;
    blockLines = [];
    listItems = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmedLine = rawLine.trim();

    if (currentMode !== 'block-scalar' && trimmedLine.startsWith('#')) {
      continue;
    }

    if (currentMode === 'list') {
      if (/^\s+-\s*(.*)$/.test(rawLine)) {
        const item = rawLine.match(/^\s+-\s*(.*)$/)[1].trim();
        listItems.push(stripQuotes(item));
        continue;
      }
      flush();
    }

    if (currentMode === 'block-scalar') {
      if (/^\s+/.test(rawLine)) {
        blockLines.push(rawLine.trim());
        continue;
      }
      if (trimmedLine === '') {
        blockLines.push('');
        continue;
      }
      flush();
    }

    const keyMatch = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      flush();
      const key = keyMatch[1];
      const val = keyMatch[2].trim();

      if (val === '>' || val === '|') {
        currentKey = key;
        currentMode = 'block-scalar';
      } else if (val === '') {
        const nextLine = lines[i + 1] || '';
        if (/^\s+-\s/.test(nextLine)) {
          currentKey = key;
          currentMode = 'list';
        } else if (/^\s+\S/.test(nextLine) && !nextLine.trim().startsWith('#')) {
          currentKey = key;
          currentMode = 'block-scalar';
        } else {
          result[key] = '';
        }
      } else if (val.startsWith('[') && val.endsWith(']')) {
        const inner = val.slice(1, -1).trim();
        if (inner.length === 0) {
          result[key] = [];
        } else {
          result[key] = inner.split(',').map((s) => stripQuotes(s.trim()));
        }
      } else {
        result[key] = stripQuotes(val);
      }
    }
  }
  flush();
  return result;
}

/** Check if an allowed-tools value is well-formed. */
export function isAllowedToolsWellFormed(val) {
  if (val === undefined || val === null) return false;
  if (Array.isArray(val)) {
    if (val.length === 0) return false;
    return val.every((item) => typeof item === 'string' && item.trim().length > 0);
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return false;
    const parts = trimmed.split(',').map((p) => p.trim());
    return parts.length > 0 && parts.every((p) => p.length > 0);
  }
  return false;
}

/** Lint one command file's frontmatter. Returns failure strings (empty = ok). */
export function lintCommandFrontmatter({ fileName, text }) {
  const failures = [];
  const { fm } = splitFrontmatter(text);
  if (fm === null) {
    failures.push(`${fileName}: missing YAML frontmatter`);
    return failures;
  }
  const parsed = parseFrontmatter(fm);
  if (!parsed) {
    failures.push(`${fileName}: malformed YAML frontmatter`);
    return failures;
  }
  if (!parsed.description || typeof parsed.description !== 'string' || !parsed.description.trim()) {
    failures.push(`${fileName}: frontmatter description is missing or empty`);
  }
  if ('allowed-tools' in parsed) {
    if (!isAllowedToolsWellFormed(parsed['allowed-tools'])) {
      failures.push(`${fileName}: allowed-tools entry is not well-formed`);
    }
  }
  if ('allowed_tools' in parsed) {
    if (!isAllowedToolsWellFormed(parsed['allowed_tools'])) {
      failures.push(`${fileName}: allowed_tools entry is not well-formed`);
    }
  }
  return failures;
}

/** Lint one skill file's frontmatter. Returns failure strings (empty = ok). */
export function lintSkillFrontmatter({ dirName, text }) {
  const failures = [];
  const { fm } = splitFrontmatter(text);
  if (fm === null) {
    failures.push(`${dirName}: missing YAML frontmatter`);
    return failures;
  }
  const parsed = parseFrontmatter(fm);
  if (!parsed) {
    failures.push(`${dirName}: malformed YAML frontmatter`);
    return failures;
  }
  if (!parsed.name || typeof parsed.name !== 'string' || !parsed.name.trim()) {
    failures.push(`${dirName}: frontmatter name is missing or empty`);
  } else if (parsed.name.trim() !== dirName) {
    failures.push(`${dirName}: frontmatter name "${parsed.name.trim()}" != directory "${dirName}"`);
  }
  if (!parsed.description || typeof parsed.description !== 'string' || !parsed.description.trim()) {
    failures.push(`${dirName}: frontmatter description is missing or empty`);
  } else {
    const desc = parsed.description.trim();
    if (desc.length > 1024) {
      failures.push(`${dirName}: description exceeds 1024 chars (${desc.length})`);
    }
    if (/[<>]/.test(desc)) {
      failures.push(`${dirName}: description contains angle brackets`);
    }
  }
  return failures;
}

/**
 * Check that all references/ citations in a file point to existing files.
 * Returns failure strings (empty = ok).
 */
export function checkFileReferences({ file, text, pluginDir: basePluginDir = pluginDir }) {
  const failures = [];
  const regex = /(?:^|[\s\(`"'\''<\[])(?:\.\.\/|\.\/)?(references\/[A-Za-z0-9_./#-]+)/g;
  let match;
  const seen = new Set();
  while ((match = regex.exec(text)) !== null) {
    let rawTarget = match[1];
    rawTarget = rawTarget.replace(/[\)\]\`"'\''\.,;:]+$/, '');
    const filePart = rawTarget.split('#')[0].replace(/\/+$/, '');
    if (!filePart || seen.has(filePart)) continue;
    seen.add(filePart);

    const inPlugin = path.join(basePluginDir, filePart);
    const inRelative = path.join(path.dirname(file), filePart);
    if (!existsSync(inPlugin) && !existsSync(inRelative)) {
      failures.push(`${path.basename(file)}: cited references file does not exist: "${filePart}"`);
    }
  }
  return failures;
}

// --- Unit & Mutation Tests ---

test('command frontmatter lint rejects missing frontmatter, empty description, and malformed allowed-tools', () => {
  assert.ok(
    lintCommandFrontmatter({ fileName: 'cmd.md', text: 'no frontmatter\n' }).some((f) => f.includes('missing YAML frontmatter')),
  );
  assert.ok(
    lintCommandFrontmatter({ fileName: 'cmd.md', text: '---\nargument-hint: x\n---\nbody\n' }).some((f) =>
      f.includes('description is missing or empty'),
    ),
  );
  assert.ok(
    lintCommandFrontmatter({ fileName: 'cmd.md', text: '---\ndescription:\n---\nbody\n' }).some((f) =>
      f.includes('description is missing or empty'),
    ),
  );
  assert.ok(
    lintCommandFrontmatter({ fileName: 'cmd.md', text: '---\ndescription: "   "\n---\nbody\n' }).some((f) =>
      f.includes('description is missing or empty'),
    ),
  );
  // Well-formed allowed-tools
  assert.deepEqual(
    lintCommandFrontmatter({
      fileName: 'cmd.md',
      text: '---\ndescription: valid\nallowed-tools:\n  - Read\n  - Bash\n---\nbody\n',
    }),
    [],
  );
  assert.deepEqual(
    lintCommandFrontmatter({
      fileName: 'cmd.md',
      text: '---\ndescription: valid\nallowed-tools: [Read, Grep]\n---\nbody\n',
    }),
    [],
  );
  assert.deepEqual(
    lintCommandFrontmatter({
      fileName: 'cmd.md',
      text: '---\ndescription: valid\nallowed-tools: Read, Grep\n---\nbody\n',
    }),
    [],
  );
  // Malformed allowed-tools
  assert.ok(
    lintCommandFrontmatter({
      fileName: 'cmd.md',
      text: '---\ndescription: valid\nallowed-tools: []\n---\nbody\n',
    }).some((f) => f.includes('allowed-tools entry is not well-formed')),
  );
  assert.ok(
    lintCommandFrontmatter({
      fileName: 'cmd.md',
      text: '---\ndescription: valid\nallowed-tools:\n---\nbody\n',
    }).some((f) => f.includes('allowed-tools entry is not well-formed')),
  );
  assert.ok(
    lintCommandFrontmatter({
      fileName: 'cmd.md',
      text: '---\ndescription: valid\nallowed-tools: ""\n---\nbody\n',
    }).some((f) => f.includes('allowed-tools entry is not well-formed')),
  );
  assert.ok(
    lintCommandFrontmatter({
      fileName: 'cmd.md',
      text: '---\ndescription: valid\nallowed-tools: [Read, ""]\n---\nbody\n',
    }).some((f) => f.includes('allowed-tools entry is not well-formed')),
  );
  assert.ok(
    lintCommandFrontmatter({
      fileName: 'cmd.md',
      text: '---\ndescription: valid\nallowed-tools: "Read, "\n---\nbody\n',
    }).some((f) => f.includes('allowed-tools entry is not well-formed')),
  );
});

test('skill frontmatter lint rejects name mismatch, missing fields, long descriptions, and angle brackets', () => {
  assert.ok(
    lintSkillFrontmatter({ dirName: 'my-skill', text: 'no frontmatter\n' }).some((f) => f.includes('missing YAML frontmatter')),
  );
  assert.ok(
    lintSkillFrontmatter({ dirName: 'my-skill', text: '---\ndescription: x\n---\n' }).some((f) =>
      f.includes('name is missing or empty'),
    ),
  );
  assert.ok(
    lintSkillFrontmatter({ dirName: 'my-skill', text: '---\nname: wrong-name\ndescription: x\n---\n' }).some((f) =>
      f.includes('!= directory'),
    ),
  );
  assert.ok(
    lintSkillFrontmatter({ dirName: 'my-skill', text: '---\nname: my-skill\n---\n' }).some((f) =>
      f.includes('description is missing or empty'),
    ),
  );
  assert.ok(
    lintSkillFrontmatter({ dirName: 'my-skill', text: '---\nname: my-skill\ndescription: ""\n---\n' }).some((f) =>
      f.includes('description is missing or empty'),
    ),
  );
  const longDesc = 'a'.repeat(1025);
  assert.ok(
    lintSkillFrontmatter({ dirName: 'my-skill', text: `---\nname: my-skill\ndescription: "${longDesc}"\n---\n` }).some((f) =>
      f.includes('exceeds 1024 chars'),
    ),
  );
  assert.ok(
    lintSkillFrontmatter({ dirName: 'my-skill', text: '---\nname: my-skill\ndescription: "has <angle> brackets"\n---\n' }).some((f) =>
      f.includes('contains angle brackets'),
    ),
  );
  assert.ok(
    lintSkillFrontmatter({ dirName: 'my-skill', text: '---\nname: my-skill\ndescription: "Node >=20 <23"\n---\n' }).some((f) =>
      f.includes('contains angle brackets'),
    ),
  );
  assert.deepEqual(
    lintSkillFrontmatter({
      dirName: 'my-skill',
      text: '---\nname: my-skill\ndescription: "Clean skill description under 1024 chars without brackets."\n---\n',
    }),
    [],
  );
});

test('references check rejects non-existent references targets', () => {
  const fakeFile = path.join(skillsDir, 'c2c-test/SKILL.md');
  const validText = 'See `references/required-mcp-tools.json` and [route](references/route-map.md).\n';
  assert.deepEqual(checkFileReferences({ file: fakeFile, text: validText, pluginDir }), []);

  const invalidText = 'See `references/non-existent-file.md` for details.\n';
  const fails = checkFileReferences({ file: fakeFile, text: invalidText, pluginDir });
  assert.ok(fails.length > 0);
  assert.ok(fails.some((f) => f.includes('non-existent-file.md')));
});

// --- Live Repository Tests ---

test('every plugin/commands/*.md has YAML frontmatter with a non-empty description and well-formed allowed-tools', () => {
  const commands = readdirSync(commandsDir).filter((name) => name.endsWith('.md')).sort();
  assert.ok(commands.length > 0, 'plugin/commands holds no command files');
  const failures = [];
  for (const fileName of commands) {
    const text = readFileSync(path.join(commandsDir, fileName), 'utf8');
    failures.push(...lintCommandFrontmatter({ fileName, text }));
  }
  assert.deepEqual(failures, []);
});

test('every plugin/skills/*/SKILL.md has name == directory and a description <= 1024 chars with no angle brackets', () => {
  const skills = readdirSync(skillsDir).filter((name) => existsSync(path.join(skillsDir, name, 'SKILL.md'))).sort();
  assert.ok(skills.length > 0, 'plugin/skills holds no skills');
  const failures = [];
  for (const dirName of skills) {
    const text = readFileSync(path.join(skillsDir, dirName, 'SKILL.md'), 'utf8');
    failures.push(...lintSkillFrontmatter({ dirName, text }));
  }
  assert.deepEqual(failures, []);
});

test('every skill and command that cites a references/ file points to a file that exists', () => {
  const failures = [];
  const commands = readdirSync(commandsDir).filter((name) => name.endsWith('.md')).sort();
  for (const fileName of commands) {
    const file = path.join(commandsDir, fileName);
    const text = readFileSync(file, 'utf8');
    failures.push(...checkFileReferences({ file, text, pluginDir }));
  }
  const skills = readdirSync(skillsDir).filter((name) => existsSync(path.join(skillsDir, name, 'SKILL.md'))).sort();
  for (const dirName of skills) {
    const file = path.join(skillsDir, dirName, 'SKILL.md');
    const text = readFileSync(file, 'utf8');
    failures.push(...checkFileReferences({ file, text, pluginDir }));
  }
  assert.deepEqual(failures, []);
});
