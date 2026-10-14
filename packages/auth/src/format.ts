import type { AuthPlan } from './plan.js';

export function authAsJson(plan: AuthPlan): string {
  return JSON.stringify(plan, null, 2) + '\n';
}

export function authAsReport(plan: AuthPlan): string {
  const lines: string[] = [];
  lines.push('# Auth plan (dry run)');
  lines.push('');
  lines.push('Nothing in this plan is applied. Role ids and user invites are not invented.');
  lines.push('');
  lines.push(`- Hosted login: ${plan.authentication.hosted_auth}`);
  lines.push(`- Embedded login: ${plan.authentication.embedded_auth}`);
  lines.push(`- Public signup: ${plan.authentication.public_signup}`);
  lines.push(`- Roles: ${plan.roles.length}`);
  lines.push(`- Portal profiles (app users): ${plan.portalUsers.length}`);
  lines.push(`- Table permission rows: ${plan.tablePermissions.length}`);
  lines.push(`- Non-table modules: ${plan.pageAccess.length}`);
  lines.push(`- Access-policy profiles: ${Object.keys(plan.accessPolicy.profiles).length}`);
  lines.push(`- Access-policy roles: ${plan.accessPolicy.roles.length}`);
  lines.push('');
  lines.push('## Roles');
  lines.push('');
  if (!plan.roles.length) lines.push('No profiles or hierarchy roles in the export.');
  for (const role of plan.roles) {
    const portal = role.portal ? ', portal app users' : '';
    const parent = role.parent ? `, reports to ${role.parent}` : '';
    lines.push(`- ${role.role_name} (${role.source}, clone ${role.clone_role}${parent}${portal})`);
  }
  lines.push('');
  lines.push('## Table permissions');
  lines.push('');
  if (!plan.tablePermissions.length) lines.push('No form grants with View.');
  for (const row of plan.tablePermissions) {
    lines.push(`- ${row.role} on ${row.table}: ${row.permissions.join(', ')} (${row.scope})`);
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  for (const note of plan.notes) lines.push(`- ${note}`);
  lines.push('');
  return lines.join('\n');
}
