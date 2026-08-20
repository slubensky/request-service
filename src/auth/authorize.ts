/**
 * Deny-by-default authorization core (see SDD.md §7 and §3, identity vs authority).
 *
 * This is the single enforcement point the identity-vs-authority model depends
 * on. It is a PURE function: given the role the server resolved for an
 * authenticated identity plus the action being attempted, it returns an
 * allow/deny decision. It performs no I/O -- callers resolve the role and pass
 * it in, so the decision is fully testable in isolation.
 *
 * Authority is driven by an explicit capability matrix, not by per-role if/else
 * branches, and keyed on two independent axes:
 *   1. platform_role (on the User) -- cross-site company_admin authority. Checked
 *      independent of any SiteRole: site/bathroom/QR/price onboarding, invite of
 *      the initial site manager, payment capture/cancel, and internal ops.
 *   2. SiteRole (role + status), scoped to the action's target site -- manager
 *      and authorized_user authority: requesting cleanings, approving an
 *      authorized user's over-limit request, managing authorized users (invite /
 *      set-limit / delete), viewing payments, replacing QR at-site.
 *
 * Each action maps to exactly one capability; a principal is granted it only if
 * the platform matrix (for their platform_role) OR the site matrix (for their
 * authorized SiteRole at that site) lists it. Adding a role is a new matrix
 * entry -- never a rewrite of this function.
 *
 * Rules (fail closed at every step):
 * - A company_admin capability is allowed on the platform axis regardless of
 *   SiteRole (cross-site). company_admin never requests cleanings / holds cards.
 * - Otherwise the principal needs a SiteRole for the action's site: no role ->
 *   deny (customer); different site -> deny; revoked or not-yet-authorized ->
 *   deny; capability not granted to the role -> deny.
 * - Starting a paid request is additionally bounded by bathroom scope; a manager
 *   has no amount limit, while an authorized_user is bounded by
 *   max_authorization_cents (over-limit routes to a manager's approval, §10).
 */

/**
 * Platform-level authority on the identity, independent of any site. Extensible:
 * a new platform role is a new key in PLATFORM_CAPABILITIES.
 */
export type PlatformRole = 'member' | 'company_admin';

/**
 * Site-scoped roles stored in SiteRole. Intentionally open for extension: a new
 * role is a new key in SITE_ROLE_CAPABILITIES, not a new branch here.
 * A `manager` has no authorization limit; an `authorized_user` self-authorizes
 * only up to their `maxAuthorizationCents`, over-limit requests routed to a
 * manager's approval (SDD §7, §10).
 */
export type Role = 'manager' | 'authorized_user';
export type RoleStatus = 'pending' | 'authorized' | 'revoked';

/**
 * Granular permissions. An action requires exactly one; principals are granted
 * sets of these via the platform and site matrices below.
 */
export type Capability =
  // Platform (company_admin) capabilities -- cross-site, internal operator.
  | 'site:create'
  | 'site:edit'
  | 'bathroom:create'
  | 'qr_token:issue'
  | 'price:manage'
  | 'site_role:invite_initial_manager'
  | 'site_role:revoke'
  | 'payment:capture'
  | 'payment:cancel'
  | 'ops:mark_completed'
  // Site-scoped (manager / authorized_user) capabilities.
  | 'cleaning_request:create'
  | 'payment_method:save'
  | 'request:approve'
  | 'site_role:invite'
  | 'site_role:set_limit'
  | 'site_role:delete'
  | 'payment:view'
  | 'qr_token:replace';

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

/**
 * The principal the server resolved for an authenticated request: the platform
 * role from the User row, plus the SiteRole (if any) for the action's target
 * site. Never constructed from client input.
 */
export interface Principal {
  platformRole: PlatformRole;
  siteRole: ResolvedSiteRole | null;
}

export type Action =
  // Company-admin (platform) actions -- cross-site internal operations.
  | { type: 'create_site' }
  | { type: 'edit_site'; siteId: string }
  | { type: 'create_bathroom'; siteId: string }
  | { type: 'issue_qr_token'; siteId: string; bathroomId: string }
  | { type: 'manage_price'; siteId: string }
  | { type: 'invite_initial_manager'; siteId: string }
  | { type: 'revoke_site_role'; siteId: string }
  | { type: 'capture_payment'; siteId: string }
  | { type: 'cancel_payment'; siteId: string }
  | { type: 'mark_completed'; siteId: string }
  // Site-scoped (manager / authorized_user) actions.
  | { type: 'create_cleaning_request'; siteId: string; bathroomId: string; amountCents: number }
  | { type: 'save_payment_method'; siteId: string }
  | { type: 'approve_request'; siteId: string }
  | { type: 'invite_site_role'; siteId: string }
  | { type: 'set_site_role_limit'; siteId: string }
  | { type: 'delete_site_role'; siteId: string }
  | { type: 'view_payment'; siteId: string }
  | { type: 'replace_qr_token'; siteId: string; bathroomId: string };

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
  create_site: 'site:create',
  edit_site: 'site:edit',
  create_bathroom: 'bathroom:create',
  issue_qr_token: 'qr_token:issue',
  manage_price: 'price:manage',
  invite_initial_manager: 'site_role:invite_initial_manager',
  revoke_site_role: 'site_role:revoke',
  capture_payment: 'payment:capture',
  cancel_payment: 'payment:cancel',
  mark_completed: 'ops:mark_completed',
  create_cleaning_request: 'cleaning_request:create',
  save_payment_method: 'payment_method:save',
  approve_request: 'request:approve',
  invite_site_role: 'site_role:invite',
  set_site_role_limit: 'site_role:set_limit',
  delete_site_role: 'site_role:delete',
  view_payment: 'payment:view',
  replace_qr_token: 'qr_token:replace',
};

/**
 * Platform matrix: capabilities held by a platform_role, independent of any
 * SiteRole and cross-site. company_admin owns onboarding (site/bathroom/QR/
 * price), invites the initial site manager, and drives payment capture/cancel
 * and internal ops. It deliberately holds neither cleaning_request:create nor
 * any hold-authorizing capability -- a company_admin never requests cleanings.
 */
const PLATFORM_CAPABILITIES: Record<PlatformRole, ReadonlySet<Capability>> = {
  member: new Set<Capability>(),
  company_admin: new Set<Capability>([
    'site:create',
    'site:edit',
    'bathroom:create',
    'qr_token:issue',
    'qr_token:replace',
    'price:manage',
    'site_role:invite_initial_manager',
    // Revoke a Manager (SDD §7, §11.1). Held on the platform axis so it applies
    // cross-site, the same way qr_token:replace sits on both axes.
    'site_role:revoke',
    'payment:capture',
    'payment:cancel',
    'ops:mark_completed',
  ]),
};

/**
 * Site matrix: capabilities each authorized SiteRole holds at its own site.
 * Deny-by-default -- an omitted (role, capability) pair is denied. A manager
 * runs a site but must NOT onboard sites/bathrooms/QR/price or capture/cancel
 * payments; those are platform (company_admin) capabilities above.
 */
const SITE_ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  manager: new Set<Capability>([
    'cleaning_request:create',
    'payment_method:save',
    'request:approve',
    'site_role:invite',
    'site_role:set_limit',
    'site_role:delete',
    'payment:view',
    'qr_token:replace',
  ]),
  // Same site capabilities as the old assistant role: an authorized user may request a
  // cleaning and save the site's mock payment method (SDD §9.4). Whether a given request
  // self-authorizes or is routed to a manager's approval is decided by amount-vs-limit in
  // authorizePaidRequest below and by the route, not by the capability set.
  authorized_user: new Set<Capability>(['cleaning_request:create', 'payment_method:save']),
};

function deny(reason: DenyReason): AuthorizationDecision {
  return { allowed: false, reason };
}

const ALLOW: AuthorizationDecision = { allowed: true };

/** The target site of an action, or null for a site-less platform action. */
function actionSiteId(action: Action): string | null {
  return 'siteId' in action ? action.siteId : null;
}

function bathroomInScope(role: ResolvedSiteRole, bathroomId: string): boolean {
  return role.bathroomScope === null || role.bathroomScope.includes(bathroomId);
}

function withinLimit(role: ResolvedSiteRole, amountCents: number): boolean {
  return role.maxAuthorizationCents !== null && amountCents <= role.maxAuthorizationCents;
}

/**
 * Extra constraints for a paid request beyond holding the capability (SDD §7):
 * the bathroom must be in scope, and — for an `authorized_user` — the amount must
 * be within their limit. A `manager` has no limit (`maxAuthorizationCents = null`
 * = unlimited) and self-authorizes any amount. For an `authorized_user`, an amount
 * over the limit is denied with `exceeds_max_authorization`; the route treats that
 * specific denial as "route to a manager's approval" (SDD §10), not a hard refusal.
 */
function authorizePaidRequest(
  role: ResolvedSiteRole,
  action: Extract<Action, { type: 'create_cleaning_request' }>,
): AuthorizationDecision {
  if (!bathroomInScope(role, action.bathroomId)) {
    return deny('bathroom_out_of_scope');
  }
  if (role.role === 'manager') {
    return ALLOW; // unlimited authorization
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
 * The one authorization decision for the whole app. Grants the action if the
 * principal's platform_role holds its capability (cross-site company_admin
 * authority) OR their authorized SiteRole at the target site holds it. Returns
 * a discriminated decision so callers must handle the deny case explicitly.
 */
export function authorize(principal: Principal, action: Action): AuthorizationDecision {
  const capability = ACTION_CAPABILITY[action.type];

  // Platform axis: company_admin authority is cross-site and needs no SiteRole.
  if (PLATFORM_CAPABILITIES[principal.platformRole].has(capability)) {
    return ALLOW;
  }

  // Site axis: a site-scoped capability requires an authorized SiteRole at the
  // action's target site. A site-less capability the platform role lacks is a
  // company_admin-only power -> deny.
  const targetSiteId = actionSiteId(action);
  if (targetSiteId === null) {
    return deny('capability_not_granted');
  }
  const role = principal.siteRole;
  if (role === null) {
    return deny('no_site_role');
  }
  if (role.siteId !== targetSiteId) {
    return deny('wrong_site');
  }
  if (role.status === 'revoked') {
    return deny('role_revoked');
  }
  if (role.status !== 'authorized') {
    return deny('requires_authorized_status');
  }
  if (!SITE_ROLE_CAPABILITIES[role.role].has(capability)) {
    return deny('capability_not_granted');
  }
  if (action.type === 'create_cleaning_request') {
    return authorizePaidRequest(role, action);
  }
  return ALLOW;
}
