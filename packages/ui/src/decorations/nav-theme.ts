/**
 * Menu labels, icons, and theme tokens carried by the export.
 * Empty sections are omitted. A hidden section stays on the model so a direct
 * link still asks for access; the menu leaves it out. A system entry keeps its
 * display name and icon and is not a link. The document records the web theme,
 * font, and icon colour.
 */

import type { App, Property, PropertyBlock } from '../../../core/src/ir.js';
import { unquote } from '../../../core/src/ir.js';
import { menuStyleFor } from '../theme-map.js';
import type { UiModel, UiNav } from '../model.js';

export interface ThemeTokens {
  theme?: string;
  font?: string;
  iconColor?: string;
  /** `'rail'` draws the left icon column; `'list'` the dark collapsible list. */
  menu?: 'rail' | 'list';
}

export interface DecoratedNav extends UiNav {
  icon?: string;
  /** Every entry is a system component: the section is a service area the menu hides. */
  system?: boolean;
  items: Array<UiNav['items'][number] & { icon?: string; system?: boolean }>;
}

export interface DecoratedModel extends UiModel {
  theme: ThemeTokens;
  nav: DecoratedNav[];
}

function propOf(properties: Property[] | undefined, key: string): string | undefined {
  const found = properties?.find((item) => item.key.toLowerCase() === key);
  return found ? unquote(found.value) : undefined;
}

function child(block: PropertyBlock | undefined, name: string): PropertyBlock | undefined {
  return block?.blocks.find((item) => item.name.toLowerCase() === name);
}

function labelFor(app: App, name: string): string {
  return (
    app.forms.find((form) => form.name === name)?.displayName ||
    app.reports.find((report) => report.name === name)?.displayName ||
    app.pages.find((page) => page.name === name)?.displayName ||
    name
  );
}

function hrefFor(app: App, kind: string, name: string): string {
  if (app.forms.some((form) => form.name === name) || kind === 'form') return `#/form/${encodeURIComponent(name)}`;
  if (app.pages.some((page) => page.name === name) || kind === 'page') return `#/page/${encodeURIComponent(name)}`;
  return `#/report/${encodeURIComponent(name)}`;
}

interface RawSection {
  name: string;
  hidden: boolean;
  icon?: string;
  components: { kind: string; name: string; properties?: Property[] }[];
}

function hasEntryProperties(sections: { components: { properties?: Property[] }[] }[]): boolean {
  return sections.some((section) => section.components.some((component) => (component.properties?.length ?? 0) > 0));
}

function fromApp(app: App): RawSection[] {
  return app.sections.map((section) => ({
    name: section.displayName || section.name,
    hidden: section.hidden,
    ...(section.icon ? { icon: section.icon } : {}),
    components: section.components.map((component) => ({
      kind: component.kind,
      name: component.name,
      ...(component.properties ? { properties: component.properties } : {}),
    })),
  }));
}

function fromWeb(web: App['devices'][number]): RawSection[] {
  return web.sections.map((section) => {
    const icon = propOf(section.properties, 'icon');
    return {
      name: propOf(section.properties, 'displayname') || section.name,
      hidden: propOf(section.properties, 'hide') === 'true',
      ...(icon ? { icon } : {}),
      components: section.components.map((component) => ({
        kind: component.kind,
        name: component.name,
        properties: component.properties,
      })),
    };
  });
}

function rawSections(app: App): RawSection[] {
  const web = app.devices.find((device) => device.device === 'web');
  // The web menu keeps each entry's display name and icon. The copied section list drops them.
  if (web && web.sections.length && (hasEntryProperties(web.sections) || !hasEntryProperties(app.sections))) {
    return fromWeb(web);
  }
  if (app.sections.length) return fromApp(app);
  return web ? fromWeb(web) : [];
}

function themeFrom(app: App): ThemeTokens {
  const web = app.devices.find((device) => device.device === 'web');
  const customize = app.configuration.find((block) => block.name.toLowerCase() === 'customize');
  const icon = child(customize, 'icon');
  const theme: ThemeTokens = {};
  const themeId = propOf(web?.customize?.properties, 'new theme');
  const font = propOf(web?.customize?.properties, 'font');
  const iconColor = propOf(icon?.properties, 'background color');
  if (themeId) theme.theme = themeId;
  theme.menu = menuStyleFor(themeId);
  if (font) theme.font = font;
  if (iconColor) theme.iconColor = iconColor;
  return theme;
}

function menuFrom(app: App): DecoratedNav[] | undefined {
  const raw = rawSections(app);
  if (!raw.length) return undefined;
  const sections: DecoratedNav[] = [];
  for (const section of raw) {
    const items: DecoratedNav['items'] = [];
    for (const component of section.components) {
      const system = component.kind === 'systemcomponent';
      const label = propOf(component.properties, 'displayname') || labelFor(app, component.name);
      const icon = propOf(component.properties, 'icon');
      items.push({
        kind: component.kind,
        name: component.name,
        label,
        href: system ? '' : hrefFor(app, component.kind, component.name),
        ...(icon ? { icon } : {}),
        ...(system ? { system: true } : {}),
      });
    }
    if (!items.length) continue;
    sections.push({
      name: section.name,
      hidden: section.hidden,
      ...(section.icon ? { icon: section.icon } : {}),
      ...(items.every((item) => item.system) ? { system: true } : {}),
      items,
    });
  }
  return sections;
}

/** Copy menu display names, icons, and theme tokens onto a built model. */
export function decorateNavTheme(model: UiModel, app: App): DecoratedModel {
  const nav = menuFrom(app);
  return {
    ...model,
    nav: nav ?? (model.nav as DecoratedNav[]),
    theme: themeFrom(app),
  };
}
