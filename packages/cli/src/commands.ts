/** Commands handled by c2c.ts. Help snapshots use this table as their coverage source. */
export const DISPATCH_COMMANDS = [
  'doctor', 'deploy', 'edit', 'plan', 'provision', 'users', 'smoke', 'sync-delta',
  'rollback-export', 'status', 'cutover-checklist', 'proof', 'fill-todos',
  'migrate-data', 'analyze', 'precheck', 'migration-report', 'parse', 'corpus',
  'features', 'schema', 'iac-drift', 'schema-corpus', 'seed', 'deluge', 'ui',
  'score-ui', 'ui-react', 'auth', 'ui-corpus', '--verify-vendor',
] as const;
