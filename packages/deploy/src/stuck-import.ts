/**
 * A project whose `project_type` is `Importing` cannot be deleted (the admin
 * delete answers INVALID_OPERATION "Your project is importing. Kindly wait
 * for some time", however old the import is) and holds its name. One still
 * Importing past STUCK_IMPORT_MAX_AGE_HOURS is stuck: the run prints one
 * guided step and stops that branch — the delete is never retried and no
 * writes are planned into it.
 */

/** Hours before an 'Importing' project counts as stuck. */
export const STUCK_IMPORT_MAX_AGE_HOURS = 6;
export const STUCK_IMPORT_MAX_AGE_MS = STUCK_IMPORT_MAX_AGE_HOURS * 60 * 60 * 1000;

/** One row of GET /baas/v1/project, reduced to the non-secret fields c2c uses. */
export interface ListedProject {
  name: string;
  id: string;
  /** project_type, e.g. 'Live' or 'Importing'. Absent on shapes that omit it. */
  projectType?: string;
  /** created_time verbatim, e.g. 'Oct 08, 2026 05:00 AM'. Absent when not returned. */
  createdTime?: string;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * The epoch ms a Catalyst `created_time` points at: epoch seconds or millis
 * (number or digit string), the console's 'Oct 08, 2026 05:00 AM' shape
 * (local time — no zone is reported), or an ISO/Date.parse-able string.
 * Anything else is undefined, never a guess.
 */
export function catalystCreatedMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return catalystCreatedMs(Number(text));
  const match = /^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)$/i.exec(text);
  if (match) {
    const month = MONTHS[match[1]!.slice(0, 3).toLowerCase()];
    if (month === undefined) return undefined;
    let hour = Number(match[4]) % 12;
    if (match[7]!.toUpperCase() === 'PM') hour += 12;
    return new Date(Number(match[3]), month, Number(match[2]), hour, Number(match[5]), Number(match[6] ?? 0)).getTime();
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The `data` record of a project-details or project-list body, so callers
 * read `project_type`/`created_time` the same way everywhere.
 */
export function projectDataRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return record;
}

/** The age of an 'Importing' project in ms, or undefined when its created_time cannot be read. */
export function importingAgeMs(project: { projectType?: string; createdTime?: string }, now = Date.now()): number | undefined {
  if (project.projectType !== 'Importing') return undefined;
  const created = catalystCreatedMs(project.createdTime);
  return created === undefined ? undefined : now - created;
}

/**
 * True only when the project is still 'Importing' and its known age reaches
 * the stuck bound. Unknown age is separate; callers still stop writes.
 */
export function isStuckImporting(project: { projectType?: string; createdTime?: string }, now = Date.now()): boolean {
  if (project.projectType !== 'Importing') return false;
  const age = importingAgeMs(project, now);
  return age !== undefined && age >= STUCK_IMPORT_MAX_AGE_MS;
}

/** Stable status classification for an Importing project. */
export function importingAgeState(project: { projectType?: string; createdTime?: string }, now = Date.now()): 'not-importing' | 'stuck' | 'young' | 'unknown' {
  if (project.projectType !== 'Importing') return 'not-importing';
  const age = importingAgeMs(project, now);
  if (age === undefined) return 'unknown';
  return age >= STUCK_IMPORT_MAX_AGE_MS ? 'stuck' : 'young';
}

/** Neutral guidance when an Importing project's age cannot be verified. */
export function unknownImportAgeGuidedStep(project: { name?: string; id?: string }): string {
  const which = project.name ? `"${project.name}" (${project.id ?? '?'})` : (project.id ?? '?');
  return `project ${which} is still importing; check its status in the Catalyst console and re-run later`;
}

/** The one guided user step a stuck 'Importing' project gets. The run stops; the delete is never retried. */
export function stuckImportGuidedStep(project: { name?: string; id?: string }): string {
  const which = project.name ? `"${project.name}" (${project.id ?? '?'})` : (project.id ?? '?');
  return (
    `project ${which} is still "Importing" — an import that never finishes leaves a project that cannot be deleted ` +
    `(the delete answers INVALID_OPERATION "Your project is importing. Kindly wait for some time"). ` +
    `Guided step: check the project in the Catalyst console; if it stays Importing, contact Catalyst support.`
  );
}
