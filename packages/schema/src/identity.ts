/**
 * One user identity, normalised once — the same rule drives `c2c users`
 * plan/invite and the data load's rewrite of Added_User / Modified_User, so
 * the invited sign-in address is the identity the migrated rows carry.
 *
 * The documented rules:
 *   - case and surrounding space never distinguish a mailbox — fold both.
 *   - a `+tag` in the local part is dropped. Catalyst Add User refuses a '+'
 *     outright ([TESTED]: 400 INVALID_INPUT "Email Id cannot contain '+'
 *     character"), so the plain mailbox is the only address an invite can
 *     carry; whether the provider delivers it as the same mailbox is
 *     [UNVERIFIED] for non-Google providers and is reported on the plan.
 *   - gmail.com / googlemail.com: dots in the local part never distinguish
 *     the mailbox and googlemail.com is the same domain — fold both.
 *     (Google's documented rule.) Whether Catalyst itself folds them is
 *     [UNVERIFIED]; the fold happens here so the source's two spellings land
 *     on one invited identity.
 *   - an identity with no '@' (a username, not an email) is kept as is.
 */
export interface AliasRule {
  /** Which normalisation fired: 'plus-tag', 'gmail-dot', or 'googlemail-domain'. */
  rule: 'plus-tag' | 'gmail-dot' | 'googlemail-domain';
}

export function userIdentityAliasRules(raw: string): AliasRule['rule'][] {
  const identity = raw.trim().toLowerCase();
  const at = identity.lastIndexOf('@');
  if (at < 0) return [];
  const local = identity.slice(0, at);
  const domain = identity.slice(at + 1);
  const rules: AliasRule['rule'][] = [];
  if (local.includes('+')) rules.push('plus-tag');
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    if (local.replace(/\+.*$/, '').includes('.')) rules.push('gmail-dot');
    if (domain === 'googlemail.com') rules.push('googlemail-domain');
  }
  return rules;
}

/** The one sign-in identity a source address maps to (see the rules above). */
export function canonicalUserIdentity(raw: string): string {
  const identity = raw.trim().toLowerCase();
  const at = identity.lastIndexOf('@');
  if (at < 0) return identity;
  let local = identity.slice(0, at);
  let domain = identity.slice(at + 1);
  local = local.replace(/\+.*$/, '');
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}
