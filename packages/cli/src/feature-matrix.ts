/**
 * Verdict source: the committed snapshot of the feature conversion matrix (id, area, feature, status).
 * Refresh with packages/cli/scripts/refresh-matrix-snapshot.mjs; do not edit rows by hand.
 */
import snapshot from '../data/feature-matrix-v4.snapshot.json' with { type: 'json' };

export interface MatrixRow {
  id: number;
  area: string;
  feature: string;
  status: string;
}

export interface MatrixSnapshot {
  matrix: string;
  source: string;
  sourceSha256: string;
  snapshotDate: string;
  provisional: boolean;
}

export const MATRIX_SNAPSHOT: MatrixSnapshot = {
  matrix: snapshot.matrix,
  source: snapshot.source,
  sourceSha256: snapshot.sourceSha256,
  snapshotDate: snapshot.snapshotDate,
  provisional: snapshot.provisional,
};

export const FEATURE_MATRIX: readonly MatrixRow[] = snapshot.rows;
