/**
 * Feature mapping table: maps every row of the Creator-to-Catalyst feature
 * matrix (v4, 194 rows) to an explicit IR predicate or an explicit reason why
 * the feature cannot be detected from the IR.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES, appFacts } from '../dist/core/src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const snapshotPath = path.join(root, 'packages/cli/data/feature-matrix-v4.snapshot.json');
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

/**
 * Aliases for rows where the core FEATURES detector label slightly differs from
 * the feature-matrix-v4 row name.
 */
export const FEATURE_ALIAS = {
  'Deluge|File tasks (upload, download)': 'Deluge|File tasks',
  'Deluge|sendsms': 'Deluge|SMS (sendsms / twilio.sms.send etc.)',
  'Field property|System Added Time / Modified Time': 'Field property|System Added / Modified Time',
  'Field type|Barcode / QR code': 'Field type|QR / Barcode field (generated code image)',
  'Field type|Checkbox': 'Field type|Checkbox (multi)',
  'Field type|Geolocation (distinct field)': 'Field type|Geolocation (Address geo capture / Added Location)',
  'Field type|Integration': 'Field type|Integration field',
  'Field type|Lookup multi (multi select or checkbox)': 'Field type|Lookup multi',
  'Field type|Lookup single (dropdown or radio)': 'Field type|Lookup single',
  'Mobile and locale|Barcode scan on mobile': 'Mobile and locale|Barcode / QR scan on mobile',
  'Report|Switch view (list, spreadsheet, kanban, calendar, timeline)': 'Report|Switch view',
  'Workflow|Approval with 2+ levels (not a matrix row)': 'Workflow|Approval (multi-level)',
  'Workflow|Payment gateway names (Stripe, PayPal, Zoho Checkout)': 'Workflow|Payment gateway names',
  'Mobile and locale|Mobile record actions (swipe, long press, tap)': 'Mobile and locale|Mobile record actions (swipe, tap, long press)',
};

/**
 * Explicit, documented reasons for rows that cannot be detected from a .ds export or IR.
 */
export const UNDETECTABLE_REASONS = {
  54: 'not in a .ds export',
  70: 'not distinguishable in the IR',
  82: 'not in the IR',
  96: 'not in a .ds export',
  105: 'not in a .ds export',
  132: 'runtime limit, not in a .ds export',
  133: 'runtime limit, not in a .ds export',
  142: 'builder feature, not in a .ds export',
  149: 'portal setting, not in a .ds export',
  150: 'portal setting, not in a .ds export',
  151: 'portal setting, not in a .ds export',
  154: 'device setting, not in a .ds export',
  157: 'not in a .ds export',
  158: 'not in a .ds export',
  159: 'not in a .ds export',
  160: 'not in a .ds export',
  161: 'not in a .ds export',
  162: 'not in a .ds export',
  167: 'not in a .ds export',
  168: 'not in a .ds export',
  169: 'not in a .ds export',
  170: 'not in a .ds export',
  171: 'not in a .ds export',
  172: 'not in a .ds export',
  173: 'not in a .ds export',
  174: 'not in a .ds export',
  175: 'Catalyst-side, not a Creator feature',
  176: 'Catalyst-side, not a Creator feature',
  177: 'Catalyst-side, not a Creator feature',
  178: 'Catalyst-side, not a Creator feature',
  179: 'Catalyst-side, not a Creator feature',
  180: 'Catalyst-side, not a Creator feature',
  181: 'account setting, not in a .ds export',
  182: 'account/IdP SAML configuration, not in a .ds export',
  183: 'Enterprise solutions workspace, not in a .ds export',
  184: 'org-level microservices setting, not in a .ds export',
  185: 'account user provisioning, not in a .ds export',
  186: 'AI modeler workspace setting, not in a .ds export',
  187: 'application import flow, not in a .ds export',
  188: 'account billing setting, not in a .ds export',
  189: 'org governance setting, not in a .ds export',
  190: 'org administration console, not in a .ds export',
  191: 'external mobile SDK, not in a .ds export',
  192: 'documentation section only, not a Creator feature',
  193: 'documentation section only, not a Creator feature',
  194: 'post-creation application setup flow, not in a .ds export',
};

const fMap = new Map();
for (const f of FEATURES) {
  const k = `${f.area}|${f.feature}`;
  const resolved = FEATURE_ALIAS[k] || k;
  fMap.set(resolved, f);
}

/**
 * Committed mapping entry for each feature matrix row.
 */
export const FEATURE_MAPPING = snapshot.rows.map((r) => {
  const k = `${r.area}|${r.feature}`;
  const f = fMap.get(k);
  if (f && typeof f.count === 'function') {
    return {
      id: r.id,
      area: r.area,
      title: r.feature,
      status: r.status,
      detectable: true,
      method: f.method,
      reason: null,
      predicate: (facts) => f.count(facts) > 0,
      count: (facts) => f.count(facts),
    };
  }
  const reason = UNDETECTABLE_REASONS[r.id] || (f ? f.method : 'not in a .ds export');
  return {
    id: r.id,
    area: r.area,
    title: r.feature,
    status: r.status,
    detectable: false,
    method: reason,
    reason,
    predicate: null,
    count: null,
  };
});

export const MAPPING_BY_ID = new Map(FEATURE_MAPPING.map((m) => [m.id, m]));

/**
 * Evaluate all detectable feature rows against an app's IR (or facts).
 * Returns a Set of detected row IDs and a Map of row ID -> occurrences.
 */
export function evaluateAppFeatures(appOrFacts) {
  const facts = appOrFacts && appOrFacts.allFields ? appOrFacts : appFacts(appOrFacts);
  const detected = new Set();
  const counts = new Map();
  for (const m of FEATURE_MAPPING) {
    if (!m.detectable || !m.predicate) continue;
    const n = m.count(facts);
    if (n > 0) {
      detected.add(m.id);
      counts.set(m.id, n);
    }
  }
  return { detected, counts };
}
