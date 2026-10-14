/**
 * Design tokens: one source for colour, spacing, type, radius, elevation and
 * motion, consumed by the shared stylesheet only through custom properties.
 *
 *  - Component rules carry no literal colours, shadows or font stacks.
 *  - Light and dark define the same roles, and text/fill pairs meet WCAG AA.
 *  - Theme palettes in the stylesheet and in theme-map come from the tokens.
 *  - The dark scheme applies on request (or device preference with "auto"),
 *    and a page without the attribute stays light.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { BASE_CSS } from '../src/styles.js';
import { THEME_PALETTES, DEFAULT_PALETTE } from '../src/theme-map.js';
import { DARK, LIGHT, MOTION, THEME_TOKENS, tokensCss, tokensStylesheet, type ColorTokens } from '../src/tokens.js';
import { parseCss, snapshotApp } from './visual-snapshot.js';

const LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:white|black)\b|sans-serif|\b\d+(?:\.\d+)?px\s+\d+(?:\.\d+)?px\s+\d+/i;

test('tokens: component rules read colours, shadows and font stacks only from custom properties', () => {
  const offenders: string[] = [];
  for (const rule of parseCss(BASE_CSS)) {
    for (const part of rule.body.split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const prop = part.slice(0, colon).trim();
      const value = part.slice(colon + 1).trim();
      if (prop.startsWith('--')) continue;
      if (LITERAL.test(value)) offenders.push(`${rule.selectors.join(',')} { ${prop}: ${value} }`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('tokens: the stylesheet starts with the token block and every var() it reads is defined', () => {
  assert.ok(BASE_CSS.startsWith(tokensCss()), 'app.css does not begin with the design tokens');
  const defined = new Set([...tokensCss().matchAll(/(--c2c-[\w-]+)\s*:/g)].map((m) => m[1]));
  // --c2c-field-height is set per field inline, with a fallback in the rule.
  const used = new Set([...BASE_CSS.matchAll(/var\((--c2c-[\w-]+)(\s*,)?/g)].filter((m) => !m[2]).map((m) => m[1]));
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, []);
});

test('tokens: light and dark define the same colour roles', () => {
  assert.deepEqual(Object.keys(DARK).sort(), Object.keys(LIGHT).sort());
  for (const role of Object.keys(LIGHT)) {
    assert.match(tokensCss(), new RegExp(`--c2c-${role}:`), `--c2c-${role} not emitted`);
  }
});

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `not a #rrggbb colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TEXT_PAIRS: [keyof ColorTokens, keyof ColorTokens][] = [
  ['ink', 'bg'],
  ['ink', 'surface'],
  ['ink', 'tint'],
  ['ink', 'stripe'],
  ['ink', 'warn-bg'],
  ['muted', 'surface'],
  ['muted', 'bg'],
  ['accent', 'surface'],
  ['danger', 'surface'],
  ['accent-ink', 'primary'],
  ['accent-ink', 'menu-head'],
  ['on-strong', 'toast-bg'],
  ['on-strong', 'danger'],
  ['on-strong', 'success'],
  ['topbar-ink', 'topbar-bg'],
  ['menu-ink', 'menu-bg'],
  ['menu-active-ink', 'menu-active-bg'],
];

test('tokens: light and dark text pairs meet WCAG AA (4.5:1)', () => {
  const fails: string[] = [];
  for (const [name, set] of [['light', LIGHT], ['dark', DARK]] as const) {
    for (const [fg, bg] of TEXT_PAIRS) {
      const ratio = contrast(set[fg], set[bg]);
      if (ratio < 4.5) fails.push(`${name}: ${fg} on ${bg} = ${ratio.toFixed(2)}`);
    }
  }
  assert.deepEqual(fails, []);
});

test('tokens: theme palettes keep menu text readable (AA 4.5:1, active entry 3:1 as bold UI text)', () => {
  const fails: string[] = [];
  for (const [id, theme] of Object.entries(THEME_TOKENS)) {
    const c = theme.colors;
    const checks: [string, number, number][] = [
      ['menu-ink on menu-bg', contrast(c['menu-ink'], c['menu-bg']), 4.5],
      ['topbar-ink on topbar-bg', contrast(c['topbar-ink'], c['topbar-bg']), 4.5],
      ['menu-active-ink on menu-active-bg', contrast(c['menu-active-ink'], c['menu-active-bg']), 3],
    ];
    for (const [what, ratio, min] of checks) if (ratio < min) fails.push(`theme ${id}: ${what} = ${ratio.toFixed(2)}`);
  }
  assert.deepEqual(fails, []);
});

test('tokens: stylesheet theme blocks and theme-map palettes come from the same tokens', () => {
  assert.equal(DEFAULT_PALETTE.accent, LIGHT.accent);
  assert.equal(DEFAULT_PALETTE.topbarBg, LIGHT['topbar-bg']);
  assert.deepEqual(Object.keys(THEME_PALETTES).sort(), Object.keys(THEME_TOKENS).sort());
  for (const [id, theme] of Object.entries(THEME_TOKENS)) {
    assert.equal(THEME_PALETTES[id]!.menu, theme.menu);
    assert.equal(THEME_PALETTES[id]!.menuBg, theme.colors['menu-bg']);
    const block = new RegExp(`html\\[data-theme="${id}"\\]\\{([^}]*)\\}`).exec(BASE_CSS);
    assert.ok(block, `no stylesheet block for theme ${id}`);
    for (const [role, value] of Object.entries(theme.colors)) assert.ok(block[1]!.includes(`--c2c-${role}:${value}`), `theme ${id} ${role}`);
  }
});

const rgb = (hex: string): string => `rgb(${[0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16)).join(', ')})`;

function golden() {
  return deriveIr(parse(readFileSync(join(process.cwd(), 'tests/golden/c2c-golden.ds'), 'utf8')));
}

test('tokens: the dark scheme re-skins page, cards and inputs; without the attribute the page stays light', async () => {
  const light = await snapshotApp(golden());
  const dark = await snapshotApp(golden(), { rootAttrs: { 'data-color-scheme': 'dark' } });
  const auto = await snapshotApp(golden(), { rootAttrs: { 'data-color-scheme': 'auto' }, scheme: 'dark' });
  const autoLight = await snapshotApp(golden(), { rootAttrs: { 'data-color-scheme': 'auto' }, scheme: 'light' });
  for (const width of [1440, 390]) {
    const key = `form@${width}`;
    assert.equal(light[key]!['body']!['background-color'], rgb(LIGHT.bg));
    assert.equal(dark[key]!['body']!['background-color'], rgb(DARK.bg));
    assert.equal(dark[key]!['body']!['color'], rgb(DARK.ink));
    assert.equal(dark[key]!['.card']!['background-color'], rgb(DARK.surface));
    assert.equal(dark[key]!['input:not([type="checkbox"]):not([type="radio"])']!['border-top-color'], rgb(DARK.border));
    assert.deepEqual(auto[key], dark[key], 'auto does not follow a dark device preference');
    assert.deepEqual(autoLight[key], light[key], 'auto does not stay light on a light device');
  }
});

test('tokens: a themed app in dark keeps its menu palette and darkens the light top strip', async () => {
  const shot = await snapshotApp(golden(), { rootAttrs: { 'data-theme': '3', 'data-color-scheme': 'dark' } });
  const home = shot['home@1440']!;
  assert.equal(home['#nav']!['background-color'], rgb(THEME_TOKENS['3']!.colors['menu-bg']));
  assert.equal(home['.topbar']!['background-color'], rgb(DARK['topbar-bg']));
  assert.equal(home['body']!['background-color'], rgb(DARK.bg));
});

test('tokens: the committed standalone token stylesheet matches the token source', () => {
  const committed = readFileSync(join(process.cwd(), 'packages/ui/tokens/c2c-tokens.css'), 'utf8');
  assert.equal(committed, tokensStylesheet(), 'packages/ui/tokens/c2c-tokens.css is stale; run npm run tokens:css');
  assert.ok(committed.endsWith(tokensCss()));
});

test('tokens: motion durations drop to 0s under prefers-reduced-motion', () => {
  const block = /@media \(prefers-reduced-motion:reduce\)\{\s*:root\{([^}]*)\}/.exec(tokensCss());
  assert.ok(block, 'no reduced-motion token block');
  for (const name of Object.keys(MOTION).filter((key) => key.startsWith('motion-'))) {
    assert.match(block[1]!, new RegExp(`--c2c-${name}:0s`), `--c2c-${name} keeps moving under reduced motion`);
  }
});
