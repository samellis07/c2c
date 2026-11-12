/**
 * Exported `new theme` number → shell palette and menu style.
 *
 * Menu-style mapping table:
 *   "3"  — list: dark collapsible list of sections, red app accent, light top strip.
 *   "9"  — rail: dark navy left icon rail, icon above label, pink active tile.
 *   "11" — list: dark left list, icon and label on one row, red accent active row.
 * Any other id, or none, keeps the default light list shell.
 *
 * The palettes themselves live in tokens.ts (THEME_TOKENS); this module maps
 * them to the shell keys the generator reads. Palette keys map to CSS custom
 * properties (`--c2c-<role>`): the app tile and
 * accent (`menuHead`, `accent`, `primary`), the top strip (`topbarBg`,
 * `topbarInk`), the rail or sidebar (`menuBg`, `menuInk`), and the active
 * menu entry (`menuActiveBg`, `menuActiveInk`).
 */
import { LIGHT, THEME_TOKENS, type ShellRole } from './tokens.js';

export interface ShellPalette {
  menu: 'rail' | 'list';
  accent: string;
  topbarBg: string;
  topbarInk: string;
  menuBg: string;
  menuInk: string;
  menuHead: string;
  menuActiveBg: string;
  menuActiveInk: string;
  primary: string;
}

function shell(menu: 'rail' | 'list', c: Record<ShellRole, string>): ShellPalette {
  return {
    menu,
    accent: c.accent,
    topbarBg: c['topbar-bg'],
    topbarInk: c['topbar-ink'],
    menuBg: c['menu-bg'],
    menuInk: c['menu-ink'],
    menuHead: c['menu-head'],
    menuActiveBg: c['menu-active-bg'],
    menuActiveInk: c['menu-active-ink'],
    primary: c.primary,
  };
}

/** The light-scheme shell from the design tokens. */
export const DEFAULT_PALETTE: ShellPalette = shell('list', LIGHT);

/** Theme palettes from the design tokens (tokens.ts THEME_TOKENS). */
export const THEME_PALETTES: Record<string, ShellPalette> = Object.fromEntries(
  Object.entries(THEME_TOKENS)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, theme]) => [id, shell(theme.menu, theme.colors)]),
);

export function paletteFor(theme?: string): ShellPalette {
  return (theme && THEME_PALETTES[theme]) || DEFAULT_PALETTE;
}

export function menuStyleFor(theme?: string): 'rail' | 'list' {
  return paletteFor(theme).menu;
}

/** Creator icon `background color` names, for the generated PWA icon. */
export const ICON_COLORS: Record<string, [number, number, number]> = {
  amethyst: [155, 81, 224],
  black: [38, 38, 38],
  blue: [47, 128, 237],
  brown: [121, 85, 72],
  cyan: [0, 151, 167],
  'dark blue': [21, 56, 120],
  'dark green': [27, 94, 32],
  gold: [203, 142, 14],
  green: [46, 125, 50],
  grey: [97, 97, 97],
  'light blue': [3, 155, 229],
  'light green': [124, 179, 66],
  orange: [230, 126, 34],
  pink: [216, 27, 96],
  purple: [123, 31, 162],
  red: [222, 73, 86],
  teal: [0, 121, 107],
  yellow: [249, 168, 37],
};

export function iconColorRgb(name?: string): [number, number, number] {
  return (name && ICON_COLORS[name.trim().toLowerCase()]) || [15, 61, 76];
}
