/**
 * Design tokens for every generated app: colour (light and dark), spacing,
 * type, radius, elevation, motion and control sizes. This is the one place their
 * values live. tokensCss() turns them into CSS custom properties
 * (`--c2c-<name>`), and the shared stylesheet in styles.ts reads only those
 * properties, never literal colours, shadows or font stacks.
 *
 * The same output is committed as a standalone, runtime-neutral stylesheet,
 * packages/ui/tokens/c2c-tokens.css, for any UI runtime to import as-is
 * (plain CSS custom properties, no build step). `npm run tokens:css`
 * rewrites it; a test fails when it drifts from this file.
 *
 * Colour schemes:
 *   - light is the default and applies on :root.
 *   - dark applies when <html data-color-scheme="dark">, or when
 *     data-color-scheme="auto" and the device prefers a dark scheme. A page
 *     without the attribute stays light.
 * Theme palettes (THEME_PALETTES) re-skin the shell per exported theme number
 * on top of either scheme; in dark they keep their menu and accent colours
 * and darken the light top strip.
 */

/** Colour roles. Every scheme defines every role. */
export interface ColorTokens {
  /** Focus ring, links, active tab, checkbox tint. */
  accent: string;
  /** Text on accent and primary fills. */
  'accent-ink': string;
  /** Body text. */
  ink: string;
  /** Secondary text: hints, captions, inactive tabs. */
  muted: string;
  /** Page background. */
  bg: string;
  /** Cards, inputs, menus. */
  surface: string;
  /** Table heads, banners, hover rows. */
  tint: string;
  /** Even table rows. */
  stripe: string;
  border: string;
  danger: string;
  success: string;
  'warn-bg': string;
  /** Text and icons on danger, success and toast fills. */
  'on-strong': string;
  /** Toast background. */
  'toast-bg': string;
  /** Backdrop behind dialogs. */
  scrim: string;
  /** Primary buttons and KPI figures. */
  primary: string;
  'topbar-bg': string;
  'topbar-ink': string;
  'menu-bg': string;
  'menu-ink': string;
  /** App tile behind the menu heading. */
  'menu-head': string;
  'menu-active-bg': string;
  'menu-active-ink': string;
}

export const LIGHT: ColorTokens = {
  accent: '#0f3d4c',
  'accent-ink': '#ffffff',
  ink: '#142226',
  muted: '#3f545c',
  bg: '#f4f7f8',
  surface: '#ffffff',
  tint: '#e9f0f2',
  stripe: '#f7fafb',
  border: '#d5dee2',
  danger: '#8d1d1d',
  success: '#1d6b3a',
  'warn-bg': '#fff4d6',
  'on-strong': '#ffffff',
  'toast-bg': '#142226',
  scrim: 'rgba(17,17,26,.45)',
  primary: '#0f3d4c',
  'topbar-bg': '#0f3d4c',
  'topbar-ink': '#ffffff',
  'menu-bg': '#ffffff',
  'menu-ink': '#0f3d4c',
  'menu-head': '#0f3d4c',
  'menu-active-bg': '#e9f0f2',
  'menu-active-ink': '#0f3d4c',
};

export const DARK: ColorTokens = {
  accent: '#7cc4d8',
  'accent-ink': '#ffffff',
  ink: '#e3eaec',
  muted: '#a9b8be',
  bg: '#0f1517',
  surface: '#182124',
  tint: '#223035',
  stripe: '#1c272a',
  border: '#33454b',
  danger: '#ff9b9b',
  success: '#7fd49c',
  'warn-bg': '#4a3b12',
  'on-strong': '#0f1517',
  'toast-bg': '#e3eaec',
  scrim: 'rgba(0,0,0,.6)',
  primary: '#1f6f86',
  'topbar-bg': '#0b2a34',
  'topbar-ink': '#ffffff',
  'menu-bg': '#182124',
  'menu-ink': '#c9dce2',
  'menu-head': '#1f6f86',
  'menu-active-bg': '#223035',
  'menu-active-ink': '#ffffff',
};

export const SPACE = {
  'space-1': '4px',
  'space-2': '8px',
  'space-3': '12px',
  'space-4': '16px',
  'space-5': '24px',
  'space-6': '32px',
} as const;

export const TYPE = {
  'font-family': 'system-ui,-apple-system,"Segoe UI",sans-serif',
  'font-family-lato': 'Lato,system-ui,-apple-system,"Segoe UI",sans-serif',
  'font-size-base': '16px',
  'font-size-2xs': '0.65rem',
  'font-size-xs': '0.72rem',
  'font-size-xs2': '0.85rem',
  'font-size-s': '0.875rem',
  'font-size-m': '1rem',
  'font-size-l': '1.25rem',
  'font-size-xl': '1.5rem',
  'font-size-icon': '18px',
  'font-size-close': '20px',
  line: '1.5',
  'line-tight': '1.3',
} as const;

export const RADIUS = {
  'radius-s': '4px',
  'radius-m': '8px',
  'radius-l': '12px',
} as const;

/** Elevation: s for cards, m for toasts and fly-outs, l for dialogs. */
export const ELEVATION = {
  'shadow-s': '0 1px 2px rgba(20,34,38,0.08)',
  'shadow-m': '0 2px 8px rgba(20,34,38,0.10)',
  'shadow-l': '0 8px 32px rgba(17,17,26,.25)',
} as const;

export const ELEVATION_DARK = {
  'shadow-s': '0 1px 2px rgba(0,0,0,0.5)',
  'shadow-m': '0 2px 8px rgba(0,0,0,0.5)',
  'shadow-l': '0 8px 32px rgba(0,0,0,.6)',
} as const;

/** Motion: durations and easing. Durations drop to 0s under prefers-reduced-motion. */
export const MOTION = {
  'motion-pulse': '1.4s',
  'ease-standard': 'ease-in-out',
} as const;

export const MOTION_REDUCED = {
  'motion-pulse': '0s',
} as const;

export const SIZE = {
  'input-height': '2rem',
  'menu-width': '16rem',
  'field-w': '19rem',
  'focus-width': '2px',
} as const;

/** Shell colours an exported theme re-skins. Keys are ColorTokens roles. */
export type ShellRole = 'accent' | 'primary' | 'topbar-bg' | 'topbar-ink' | 'menu-bg' | 'menu-ink' | 'menu-head' | 'menu-active-bg' | 'menu-active-ink';

export interface ThemeTokens {
  menu: 'rail' | 'list';
  colors: Record<ShellRole, string>;
}

/**
 * Exported `new theme` number -> shell palette and menu style.
 *   "3"  — list: dark collapsible list of sections, red app accent, light top strip.
 *   "9"  — rail: dark navy left icon rail, icon above label, pink active tile.
 *   "11" — list: dark left list, icon and label on one row, red accent active row.
 * Any other id, or none, keeps the default light list shell.
 */
export const THEME_TOKENS: Record<string, ThemeTokens> = {
  '3': {
    menu: 'list',
    colors: {
      accent: '#de4956',
      primary: '#232731',
      'topbar-bg': '#f0f0f0',
      'topbar-ink': '#333333',
      'menu-bg': '#232731',
      'menu-ink': '#cdd1d8',
      'menu-head': '#de4956',
      'menu-active-bg': '#101115',
      'menu-active-ink': '#ffffff',
    },
  },
  '9': {
    menu: 'rail',
    colors: {
      accent: '#d03c6a',
      primary: '#211f53',
      'topbar-bg': '#ffffff',
      'topbar-ink': '#333333',
      'menu-bg': '#211f53',
      'menu-ink': '#cfcee8',
      'menu-head': '#d03c6a',
      'menu-active-bg': '#373570',
      'menu-active-ink': '#ffffff',
    },
  },
  '11': {
    menu: 'list',
    colors: {
      accent: '#e71e3a',
      primary: '#161625',
      'topbar-bg': '#f1f1f6',
      'topbar-ink': '#333333',
      'menu-bg': '#161625',
      'menu-ink': '#c9c9e0',
      'menu-head': '#e71e3a',
      'menu-active-bg': '#e71e3a',
      'menu-active-ink': '#ffffff',
    },
  },
};

const byName = (a: [string, unknown], b: [string, unknown]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** Declarations sorted by token name, so the stylesheet bytes never depend on object key order. */
function decls(values: Record<string, string>): string {
  return Object.entries(values)
    .sort(byName)
    .map(([name, value]) => `--c2c-${name}:${value};`)
    .join('\n');
}

function inline(values: Record<string, string>): string {
  return Object.entries(values)
    .sort(byName)
    .map(([name, value]) => `--c2c-${name}:${value}`)
    .join(';');
}

/** Dark-scheme declarations, shared by the explicit and the device-preference selectors. */
function darkBlock(selector: string): string {
  return `${selector}{\n${decls({ ...DARK, ...ELEVATION_DARK })}\n}\n${selector}[data-theme]{--c2c-topbar-bg:${DARK['topbar-bg']};--c2c-topbar-ink:${DARK['topbar-ink']}}`;
}

/** Every token as CSS custom properties: :root (light), dark, then theme palettes. */
export function tokensCss(): string {
  const root = `:root{\n${decls({ ...LIGHT, ...SPACE, ...TYPE, ...RADIUS, ...ELEVATION, ...MOTION, ...SIZE })}\n}`;
  const dark = `/* Dark scheme: opt-in per page, or follow the device with data-color-scheme="auto". */\n${darkBlock('html[data-color-scheme="dark"]')}\n@media (prefers-color-scheme:dark){\n${darkBlock('html[data-color-scheme="auto"]')}\n}`;
  const themes = Object.entries(THEME_TOKENS)
    .sort(byName)
    .map(([id, theme]) => `html[data-theme="${id}"]{${inline(theme.colors)}}`)
    .join('\n');
  const reduced = `@media (prefers-reduced-motion:reduce){\n:root{\n${decls(MOTION_REDUCED)}\n}\n}`;
  return `${root}\n${dark}\n${reduced}\n/* Theme palettes keyed by the export's new-theme number. */\n${themes}\n`;
}

/** The standalone token stylesheet (packages/ui/tokens/c2c-tokens.css): a header, then tokensCss(). */
export function tokensStylesheet(): string {
  return `/* c2c design tokens: generated from packages/ui/src/tokens.ts by npm run tokens:css. Do not edit by hand. */\n${tokensCss()}`;
}
