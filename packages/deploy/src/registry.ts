/**
 * Optional project registry file (--projects). A customer does not need one: the org
 * and project come from --org/--project, c2c-deploy.json, or the Catalyst CLI
 * login. When a file is passed, never_touch and stuck_unusable still refuse
 * those project ids, and aliases still rename an app link.
 */
export interface ProjectRegistry {
  /** Set when the file names an org. Not an allow-list. */
  org: string;
  /** Customer data centre. Omitted means configuration is incomplete. */
  dc?: string;
  env: string;
  projects: Record<string, string>;
  never_touch?: Record<string, string>;
  stuck_unusable?: Record<string, string>;
  aliases?: Record<string, string>;
}

/** No bundled projects. Used when --projects is omitted. */
export function emptyRegistry(): ProjectRegistry {
  return { org: '', env: 'Development', projects: {} };
}
