/**
 * Desk aggregate themes, and the rollup of a forum case onto them.
 *
 * The join is a closed table. A case already carries one category and one
 * read theme from the forum taxonomy. This module does not read thread text
 * and does not discover topics. A symptom phrase is used only for Actions,
 * the one Desk theme with no forum category of its own, and only as a whole
 * multi-word phrase.
 */
import catalogueJson from '../data/desk-aggregate-themes.json' with { type: 'json' };

export const FORUM_CATEGORIES = [
  'fields',
  'forms',
  'reports',
  'workflows',
  'deluge',
  'approvals/blueprints',
  'payments',
  'pages/widgets',
  'portals',
  'users/roles/permissions',
  'integrations/connections',
  'apis',
  'mobile/offline',
  'pdf/print',
  'notifications/mail',
  'scheduling/timezones',
  'limits/performance',
  'data import/export',
  'environments/deploy',
  'billing/licensing',
  'none',
] as const;

export const PRODUCT_AXIS_IDS = [
  'portals-permissions',
  'schedule-cron',
  'notifications-email-sms',
  'pdf-record-templates',
  'mobile-pwa-offline',
  'custom-api',
  'backup-export',
] as const;

export const DESK_THEME_NONE = 'none';

const SCHEMA = 'c2c-desk-aggregate-themes/1';
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface DeskAggregateTheme {
  id: string;
  label: string;
  priority: number;
  productAxis: boolean;
  deskBasis: string;
  catalystShape: string;
  forumCategories: readonly string[];
  forumReadThemes: readonly string[];
  symptomPhrases: readonly string[];
}

export interface DeskThemeCatalogue {
  schema: string;
  note: string;
  method: string;
  unmappedForumCategories: readonly string[];
  themes: readonly DeskAggregateTheme[];
}

export interface ForumCaseAxes {
  category?: string | null;
  readTheme?: string | null;
  symptom?: string | null;
}

export interface DeskCluster {
  deskTheme: string;
  deskThemes: readonly string[];
  matchedBy: 'read-theme' | 'category' | 'symptom' | 'none';
}

interface Hit {
  id: string;
  specificity: number;
  priority: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${label} must be a list of non-empty strings`);
  }
  return value as readonly string[];
}

function normalizeWords(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function phraseHits(symptom: string, phrase: string): boolean {
  const needle = normalizeWords(phrase);
  if (!needle.includes(' ')) return false;
  return ` ${symptom} `.includes(` ${needle} `);
}

export function assertDeskCatalogue(catalogue: unknown): asserts catalogue is DeskThemeCatalogue {
  if (!isRecord(catalogue)) throw new Error('desk theme catalogue must be an object');
  if (catalogue.schema !== SCHEMA) throw new Error(`desk theme schema must be ${SCHEMA}`);
  if (typeof catalogue.note !== 'string' || catalogue.note.trim() === '') throw new Error('desk theme catalogue needs a note');
  if (typeof catalogue.method !== 'string' || catalogue.method.trim() === '') throw new Error('desk theme catalogue needs a method');
  if (!Array.isArray(catalogue.themes) || catalogue.themes.length === 0) throw new Error('desk theme catalogue needs themes');

  const themes: DeskAggregateTheme[] = [];
  const ids = new Set<string>();
  const priorities = new Set<number>();
  const categories = new Set<string>();
  const readThemes = new Set<string>();
  for (const entry of catalogue.themes) {
    if (!isRecord(entry)) throw new Error('each desk theme must be an object');
    const id = entry.id;
    const label = entry.label;
    const priority = entry.priority;
    const deskBasis = entry.deskBasis;
    const catalystShape = entry.catalystShape;
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`desk theme id is not a slug: ${String(id)}`);
    if (id === DESK_THEME_NONE) throw new Error('none is the unmatched primary, not a theme id');
    if (ids.has(id)) throw new Error(`duplicate desk theme id ${id}`);
    ids.add(id);
    if (typeof label !== 'string' || label.trim() === '') throw new Error(`desk theme ${id} needs a label`);
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1) {
      throw new Error(`desk theme ${id} needs a positive integer priority`);
    }
    if (priorities.has(priority)) throw new Error(`duplicate desk theme priority ${priority}`);
    priorities.add(priority);
    if (typeof entry.productAxis !== 'boolean') throw new Error(`desk theme ${id} needs a productAxis flag`);
    if (typeof deskBasis !== 'string' || deskBasis.trim() === '') throw new Error(`desk theme ${id} needs a deskBasis`);
    if (typeof catalystShape !== 'string' || catalystShape.trim() === '') throw new Error(`desk theme ${id} needs a catalystShape`);
    const forumCategories = stringList(entry.forumCategories, `${id} forumCategories`);
    const forumReadThemes = stringList(entry.forumReadThemes, `${id} forumReadThemes`);
    const symptomPhrases = stringList(entry.symptomPhrases, `${id} symptomPhrases`);
    for (const category of forumCategories) {
      if (!(FORUM_CATEGORIES as readonly string[]).includes(category)) throw new Error(`${id} names an unknown forum category ${category}`);
      if (category === DESK_THEME_NONE) throw new Error(`${id} cannot claim the none category`);
      if (categories.has(category)) throw new Error(`forum category ${category} is mapped twice`);
      categories.add(category);
    }
    for (const readTheme of forumReadThemes) {
      if (!ID_RE.test(readTheme) || readTheme === 'other') throw new Error(`${id} names an unusable read theme ${readTheme}`);
      if (readThemes.has(readTheme)) throw new Error(`read theme ${readTheme} is mapped twice`);
      readThemes.add(readTheme);
    }
    for (const phrase of symptomPhrases) {
      const normalized = normalizeWords(phrase);
      if (phrase !== normalized || !normalized.includes(' ')) {
        throw new Error(`${id} symptom phrase must be lowercase whole words: ${phrase}`);
      }
    }
    if (id === 'actions') {
      if (forumCategories.length > 0 || forumReadThemes.length > 0 || symptomPhrases.length === 0) {
        throw new Error('actions joins only through symptom phrases');
      }
    } else if (symptomPhrases.length > 0) {
      throw new Error(`only actions may use symptom phrases (${id})`);
    } else if (forumCategories.length === 0 && forumReadThemes.length === 0) {
      throw new Error(`desk theme ${id} has no forum join`);
    }
    themes.push({
      id,
      label,
      priority,
      productAxis: entry.productAxis,
      deskBasis,
      catalystShape,
      forumCategories,
      forumReadThemes,
      symptomPhrases,
    });
  }

  const count = themes.length;
  for (let priority = 1; priority <= count; priority += 1) {
    if (!priorities.has(priority)) throw new Error(`desk theme priorities must be 1..${count}, missing ${priority}`);
  }
  const productAxes = themes.filter((theme) => theme.productAxis).map((theme) => theme.id).sort();
  const expectedAxes = [...PRODUCT_AXIS_IDS].sort();
  if (productAxes.length !== expectedAxes.length || productAxes.some((id, index) => id !== expectedAxes[index])) {
    throw new Error(`product axes must be ${expectedAxes.join(', ')}`);
  }
  const unmapped = stringList(catalogue.unmappedForumCategories, 'unmappedForumCategories');
  const covered = new Set<string>([...categories, ...unmapped]);
  if (covered.size !== FORUM_CATEGORIES.length || FORUM_CATEGORIES.some((category) => !covered.has(category))) {
    throw new Error('mapped categories plus unmappedForumCategories must partition the forum categories');
  }
  if (unmapped.some((category) => categories.has(category))) {
    throw new Error('a forum category is both mapped and unmapped');
  }
}

assertDeskCatalogue(catalogueJson);

export const DESK_THEME_CATALOGUE: DeskThemeCatalogue = catalogueJson;
export const DESK_AGGREGATE_THEMES: readonly DeskAggregateTheme[] = catalogueJson.themes;

const MATCHED_BY = ['read-theme', 'category', 'symptom'] as const;

export function clusterForumCase(
  axes: ForumCaseAxes,
  themes: readonly DeskAggregateTheme[] = DESK_AGGREGATE_THEMES,
): DeskCluster {
  const category = axes.category ?? '';
  const readTheme = axes.readTheme ?? '';
  const symptom = normalizeWords(axes.symptom ?? '');
  const hits: Hit[] = [];
  for (const theme of themes) {
    let specificity: number | null = null;
    if (readTheme !== '' && readTheme !== 'other' && theme.forumReadThemes.includes(readTheme)) specificity = 0;
    else if (category !== '' && theme.forumCategories.includes(category)) specificity = 1;
    else if (symptom !== '' && theme.symptomPhrases.some((phrase) => phraseHits(symptom, phrase))) specificity = 2;
    if (specificity !== null) hits.push({ id: theme.id, specificity, priority: theme.priority });
  }
  hits.sort((a, b) => a.specificity - b.specificity || a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const primary = hits[0];
  if (!primary) return { deskTheme: DESK_THEME_NONE, deskThemes: [], matchedBy: 'none' };
  return {
    deskTheme: primary.id,
    deskThemes: hits.map((hit) => hit.id),
    matchedBy: MATCHED_BY[primary.specificity] ?? 'none',
  };
}
