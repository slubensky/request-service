/**
 * Deny-by-default authorization core (see SDD.md §7 and §3, identity vs authority).
 *
 * This is the single enforcement point the identity-vs-authority model depends
 * on. It is a PURE function: given the role the server resolved for an
 * authenticated identity plus the action being attempted, it returns an
 * allow/deny decision. It performs no I/O -- callers resolve the role and pass
 * it in, so the decision is fully testable in isolation.
 *
 * Authority is driven by an explicit capability matrix (ROLE_CAPABILITIES), not
 * by per-role if/else branches. Each action maps to exactly one capability; a
 * role grants a capability only if the matrix lists it. Adding a new role (e.g.
 * the forthcoming cross-site company_admin that owns site/bathroom onboarding,
 * QR issuance, and payment capture/cancel) is a data change -- a new matrix
 * entry -- never a rewrite of this function. Capabilities that no current role
 * holds (payment:capture, payment:cancel, qr_token:replace) are deliberately
 * reserved for that role and denied to everyone until it is defined.
 *
 * Rules (fail closed at every step):
 * - No role -> deny. A customer / public visitor holds no role (SDD §3.2).
 * - Role for a different site -> deny. Authority never crosses sites.
 * - Revoked -> deny; anything short of `authorized` -> deny.
 * - The action's capability must be granted to the role by the matrix.
 * - Starting a paid request is additionally bounded by bathroom scope and
 *   max_authorization_cents; a pending assistant can never self-authorize.
 * - Any action whose capability is ungranted -> deny (complete mediation).
 */

/**
 * Site-scoped roles stored in SiteRole. Intentionally open for extension: a new
 * role is a new key in ROLE_CAPABILITIES, not a new branch here. Cross-site
 * roles (company_admin) resolve through a separate path and reuse this matrix.
 */
export type Role = 'manager' | 'assistant';
export type RoleStatus = 'pending' | 'authorized' | 'revoked';

/**
 * Granular permissions. An action requires exactly one; roles are granted sets
 * of these via ROLE_CAPABILITIES. Reserved capabilities have no current holder.
 */
export type Capability =
  | 'cleaning_request:create'
  | 'assistant_request:approve'
  | 'site_role:invite'
  | 'site_role:promote'
  | 'site_role:revoke'
  | 'qr_token:replace'
  | 'payment:capture'
  | 'payment:cancel';

/**
 * The authority record the server resolved for the identity, scoped to one
 * site. Never constructed from client input -- always read from the SiteRole
 * table for the authenticated user.
 */
export interface ResolvedSiteRole {
  siteId: string;
  role: Role;
  status: RoleStatus;
  /** Null = no ceiling defined; treated as "cannot authorize a paid amount". */
  maxAuthorizationCents: number | null;
  /** Null = all bathrooms in the site; otherwise an allow-list of bathroom ids. */
  bathroomScope: readonly string[] | null;
}

export type Action =
  | { type: 'create_cleaning_request'; siteId: string; bathroomId: string; amountCents: number }
  | { type: 'capture_payment'; siteId: string }
  | { type: 'cancel_payment'; siteId: string }
  | { type: 'invite_site_role'; siteId: string }
  | { type: 'promote_site_role'; siteId: string }
  | { type: 'revoke_site_role'; siteId: string }
  | { type: 'replace_qr_token'; siteId: string; bathroomId: string }
  | { type: 'approve_assistant_request'; siteId: string };

export type DenyReason =
  | 'no_site_role'
  | 'wrong_site'
  | 'role_revoked'
  | 'requires_authorized_status'
  | 'capability_not_granted'
  | 'bathroom_out_of_scope'
  | 'exceeds_max_authorization'
  | 'no_authorization_limit';

export type AuthorizationDecision = { allowed: true } | { allowed: false; reason: DenyReason };

/** Each action requires exactly one capability. */
const ACTION_CAPABILITY: Record<Action['type'], Capability> = {
  create_cleaning_request: 'cleaning_request:create',
  capture_payment: 'payment:capture',
  cancel_payment: 'payment:cancel',
  invite_site_role: 'site_role:invite',
  promote_site_role: 'site_role:promote',
  revoke_site_role: 'site_role:revoke',
  replace_qr_token: 'qr_token:replace',
  approve_assistant_request: 'assistant_request:approve',
};

/**
 * The capability matrix: capabilities each authorized role holds. Deny-by-
 * default -- an omitted (role, capability) pair is denied. Managers run a site
 * but do NOT own site/bathroom onboarding, QR issuance, or payment
 * capture/cancel; those capabilities are reserved for the cross-site
 * company_admin role and appear in no entry below, so they are denied to every
 * current role until that role is defined.
 */
const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  manager: new Set<Capability>([
    'cleaning_request:create',
    'assistant_request:approve',
    'site_role:invite',
    'site_role:promote',
    'site_role:revoke',
  ]),
  assistant: new Set<Capability>(['cleaning_request:create']),
};

function deny(reason: DenyReason): AuthorizationDecision {
  return { allowed: false, reason };
}

const ALLOW: AuthorizationDecision = { allowed: true };

function grants(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.has(capability) ?? false;
}

function bathroomInScope(role: ResolvedSiteRole, bathroomId: string): boolean {
  return role.bathroomScope === null || role.bathroomScope.includes(bathroomId);
}

function withinLimit(role: ResolvedSiteRole, amountCents: number): boolean {
  return role.maxAuthorizationCents !== null && amountCents <= role.maxAuthorizationCents;
}

/**
 * Extra constraints for a paid request beyond holding the capability: the
 * bathroom must be in scope and the amount within the role's ceiling.
 */
function authorizePaidRequest(
  role: ResolvedSiteRole,
  action: Extract<Action, { type: 'create_cleaning_request' }>,
): AuthorizationDecision {
  if (!bathroomInScope(role, action.bathroomId)) {
    return deny('bathroom_out_of_scope');
  }
  if (role.maxAuthorizationCents === null) {
    return deny('no_authorization_limit');
  }
  if (!withinLimit(role, action.amountCents)) {
    return deny('exceeds_max_authorization');
  }
  return ALLOW;
}

/**
 * The one authorization decision for the whole app. `role` is the role the
 * server resolved for the authenticated identity at the action's site, or null
 * when the identity has no role there (a customer). Returns a discriminated
 * decision so callers must handle the deny case explicitly.
 */
export function authorize(role: ResolvedSiteRole | null, action: Action): AuthorizationDecision {
  if (role === null) {
    return deny('no_site_role');
  }
  if (role.siteId !== action.siteId) {
    return deny('wrong_site');
  }
  if (role.status === 'revoked') {
    return deny('role_revoked');
  }
  if (role.status !== 'authorized') {
    return deny('requires_authorized_status');
  }
  if (!grants(role.role, ACTION_CAPABILITY[action.type])) {
    return deny('capability_not_granted');
  }
  if (action.type === 'create_cleaning_request') {
    return authorizePaidRequest(role, action);
  }
  return ALLOW;
}
