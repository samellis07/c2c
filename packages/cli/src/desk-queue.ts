/**
 * Work order for the feature matrix and the feature-app queue.
 *
 * Band order is Desk category aggregates, metadata only. The 12-month
 * category spine is form workflow, pages, custom API, actions, environments,
 * backup, then schedules. One-month keyword share inserts mail, mobile, and
 * portals immediately before custom API. PDF and record templates sit
 * immediately before schedules. Rows with no theme stay last.
 *
 * Inside a band, work still to start comes before an adapter that exists,
 * then by matrix id. The snapshot file stays in id order; analyze walks that
 * order. This module is the queue.
 *
 * The order is a stable sort of those bands. No ranking library is used.
 */
import rankFile from '../data/desk-aggregate-rank.json' with { type: 'json' };
import { FEATURE_MATRIX, type MatrixRow } from './feature-matrix.js';

export interface DeskBand {
  id: string;
  label: string;
}

export interface RankedRow extends MatrixRow {
  band: string;
  bandLabel: string;
  /** Zero-based band index. Lower is earlier in the queue. */
  bandRank: number;
}

const FEATURE_APP_STATUSES = new Set(['not-started', 'adapter-written']);

/** Lower is earlier inside a band. Unknown statuses sort after the known ones. */
const STATUS_RANK: Record<string, number> = {
  'not-started': 0,
  'adapter-written': 1,
  'built-in-Creator': 2,
  migrated: 3,
  verified: 4,
  'not a Creator feature': 5,
};

const bands = rankFile.bands as readonly DeskBand[];
const rowBand = rankFile.rowBand as Readonly<Record<string, string>>;

const bandById = new Map<string, { band: DeskBand; bandRank: number }>();
bands.forEach((band, bandRank) => {
  if (bandById.has(band.id)) throw new Error(`duplicate desk band ${band.id}`);
  bandById.set(band.id, { band, bandRank });
});

export function deskBands(): readonly DeskBand[] {
  return bands;
}

export function rankMatrix(rows: readonly MatrixRow[] = FEATURE_MATRIX): RankedRow[] {
  const ranked = rows.map((row) => {
    const bandId = rowBand[String(row.id)];
    const found = bandId ? bandById.get(bandId) : undefined;
    if (!found) throw new Error(`matrix row ${row.id} has no desk band`);
    return { ...row, band: found.band.id, bandLabel: found.band.label, bandRank: found.bandRank };
  });
  ranked.sort(
    (a, b) => a.bandRank - b.bandRank || (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.id - b.id,
  );
  return ranked;
}

/** Rows that still need a feature app: not started, or an adapter with no migration yet. */
export function rankFeatureApps(rows: readonly MatrixRow[] = FEATURE_MATRIX): RankedRow[] {
  return rankMatrix(rows).filter((row) => FEATURE_APP_STATUSES.has(row.status));
}
