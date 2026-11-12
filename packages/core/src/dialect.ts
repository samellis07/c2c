/**
 * Creator .ds dialect detection and normalization.
 *
 * Two syntactic dialects for whole-app exports:
 * - D1: forms-block (`forms { form X { ... } }`) + top-level `web { }` block
 * - D2: section-field without forms/web blocks (`section S { form X { ... } }`)
 *
 * Files without `application "..."` are snippets (deluge scripts, macros).
 * Files with mixed or unexpected markers are ambiguous.
 */

import type { Document } from './cst.js';
import type { App } from './ir.js';

export const DIALECT_MARKERS = {
  D1_forms_block: /^\s*forms\s*\{/m,
  D2_section_field: /^\s*section\s+\w+/m,
  L1_web_block: /^\s*web\s*\{/m,
  L2_phone_block: /^\tphone\s*\{/m,
  L3_tablet_block: /^\ttablet\s*\{/m,
  L4_pages_block: /^\tpages\s*\{/m,
  N1_AI_properties: /AI_Properties/,
  N2_Formula_props: /Formula_Properties/,
  N3_qrcode: /type\s*=\s*qrcode/,
  N4_batchworkflow: /batchworkflow/,
  N5_blueprint: /blueprint/,
} as const;

export type DialectMarker = keyof typeof DIALECT_MARKERS;
export type Dialect = 'D1' | 'D2' | 'ambiguous' | 'snippet';
export type GenerationClassifier = 'C6-likely' | 'AMBIGUOUS' | 'C5-candidate' | 'SNIPPET';

export interface DialectDetectionResult {
  dialect: Dialect;
  generation: GenerationClassifier;
  markers: DialectMarker[];
}

/**
 * Detect dialect and generation from .ds source text or parsed Document.
 * Follows exact marker rules from creator-versions.md §10.
 */
export function detectDialect(source: string | Document): DialectDetectionResult {
  const text = typeof source === 'string' ? source : source.source;
  const isApp = /^\s*application\s+"/m.test(text);

  const matchedMarkers: DialectMarker[] = [];
  for (const [key, regex] of Object.entries(DIALECT_MARKERS) as [DialectMarker, RegExp][]) {
    if (regex.test(text)) matchedMarkers.push(key);
  }

  if (!isApp) {
    return {
      dialect: 'snippet',
      generation: 'SNIPPET',
      markers: matchedMarkers,
    };
  }

  const hasForms = DIALECT_MARKERS.D1_forms_block.test(text);
  const hasWeb = DIALECT_MARKERS.L1_web_block.test(text);
  const hasSection = DIALECT_MARKERS.D2_section_field.test(text);
  const hasForm = /^\s*form\s+\w+/m.test(text);

  let dialect: Dialect = 'ambiguous';
  if (hasForms && hasWeb) {
    dialect = 'D1';
  } else if (!hasForms && !hasWeb && (hasSection || hasForm)) {
    dialect = 'D2';
  }

  const hasPhone = DIALECT_MARKERS.L2_phone_block.test(text);
  const hasTablet = DIALECT_MARKERS.L3_tablet_block.test(text);

  let generation: GenerationClassifier = 'AMBIGUOUS';
  if (dialect === 'D1') {
    generation = hasPhone && hasTablet ? 'C6-likely' : 'AMBIGUOUS';
  } else if (dialect === 'D2') {
    generation = hasPhone || hasTablet ? 'AMBIGUOUS' : 'C5-candidate';
  }

  return {
    dialect,
    generation,
    markers: matchedMarkers,
  };
}

/**
 * Normalise an App IR into the common IR representation across D1 and D2.
 * - Bridges D1's web.sections into app.sections and links form/report/page sections.
 * - Bridges D2's app.sections into a web device layout and links default report views.
 */
export function normaliseDialect(app: App): void {
  const web = app.devices.find((d) => d.device === 'web');
  if (web && !app.sections.length) {
    // D1 app: populate app.sections from web.sections
    for (const ws of web.sections) {
      const displayNameProp = ws.properties.find((p) => p.key.toLowerCase() === 'displayname')?.value;
      const iconProp = ws.properties.find((p) => p.key.toLowerCase() === 'icon')?.value;
      const hideProp = ws.properties.find((p) => p.key.toLowerCase() === 'hide')?.value;
      const cleanVal = (v?: string) => v?.replace(/^["']|["']$/g, '');

      app.sections.push({
        name: ws.name,
        displayName: cleanVal(displayNameProp),
        icon: cleanVal(iconProp),
        hidden: hideProp === 'true',
        components: ws.components.map((c) => {
          const r = app.reports.find((x) => x.name === c.name);
          return { kind: r ? r.type : c.kind, name: c.name };
        }),
        properties: ws.properties,
        ...(ws.space ? { space: ws.space } : {}),
        span: ws.span,
      });
    }
    // Link form, report, and page sections from app.sections
    for (const sec of app.sections) {
      for (const comp of sec.components) {
        if (comp.kind === 'form') {
          const f = app.forms.find((x) => x.name === comp.name);
          if (f && !f.section) f.section = sec.name;
        } else if (comp.kind === 'page') {
          const p = app.pages.find((x) => x.name === comp.name);
          if (p && !p.section) p.section = sec.name;
        } else {
          const r = app.reports.find((x) => x.name === comp.name);
          if (r && !r.section) r.section = sec.name;
        }
      }
    }
  } else if (!web && app.sections.length) {
    // D2 app: populate web device from app.sections
    app.devices.push({
      device: 'web',
      sections: app.sections.map((s) => ({
        name: s.name,
        ...(s.space ? { space: s.space } : {}),
        properties: s.properties,
        components: s.components.map((c) => ({
          kind: c.kind,
          name: c.name,
          properties: [],
          views: [],
          span: s.span,
        })),
        span: s.span,
      })),
      unused: [],
      forms: [],
      components: [],
      span: { start: 0, end: 0 },
    });
    // For D2 report views declared without device, default to 'web'
    for (const r of app.reports) {
      for (const v of r.views) {
        if (!v.device) v.device = 'web';
      }
    }
  }
}
