/**
 * Drizzle schema for the QR bathroom cleaning service (see SDD.md §4, Data model).
 *
 * Security-relevant invariants encoded here:
 * - QRToken stores `tokenHash` only -- never the raw token (SDD §5).
 * - User is anchored to a Cognito subject; no password column exists (SDD §6).
 * - SiteRole is the sole source of site authority; deny-by-default lives in the
 *   authorization module, but the shape (role/status/scope/limit) is defined here.
 * - PaymentAuthorization holds Stripe reference IDs only -- no raw card data.
 *
 * All access goes through Drizzle's typed, parameterized query builder; no raw
 * string SQL is constructed from untrusted input anywhere in the app.
 */
import { relations, sql } from 'drizzle-orm';
import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const bathroomStatus = pgEnum('bathroom_status', ['active', 'inactive']);
export const qrTokenStatus = pgEnum('qr_token_status', ['active', 'revoked']);
export const userStatus = pgEnum('user_status', ['active', 'disabled']);
// Platform-level authority on the identity itself, independent of any SiteRole.
// company_admin is an internal operator (cross-site); it is seeded/granted
// internally and NEVER acquired via self-service, QR scan, or Cognito login.
// Extensible: a new platform role is a new enum value + matrix entry.
export const platformRoleName = pgEnum('platform_role', ['member', 'company_admin']);
export const siteRoleName = pgEnum('site_role_name', ['manager', 'authorized_user']);
export const siteRoleStatus = pgEnum('site_role_status', ['pending', 'authorized', 'revoked']);
export const cleaningRequestStatus = pgEnum('cleaning_request_status', [
  'authorizing',
  'authorized',
  'completed',
  'canceled',
  'expired',
]);
export const paymentAuthorizationStatus = pgEnum('payment_authorization_status', [
  'requires_capture',
  'captured',
  'canceled',
  'expired',
]);
export const approvalStatus = pgEnum('request_approval_status', [
  'pending',
  'granted',
  'used',
  'expired',
]);

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const sites = pgTable('sites', {
  id: id(),
  name: text('name').notNull(),
  address: text('address').notNull(),
  timezone: text('timezone').notNull(),
  currency: text('currency').notNull(),
  fixedPriceCents: integer('fixed_price_cents').notNull(),
  terms: text('terms'),
  createdAt: createdAt(),
});

export const bathrooms = pgTable('bathrooms', {
  id: id(),
  siteId: uuid('site_id')
    .notNull()
    .references(() => sites.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  status: bathroomStatus('status').notNull().default('active'),
  createdAt: createdAt(),
});

export const qrTokens = pgTable(
  'qr_tokens',
  {
    id: id(),
    bathroomId: uuid('bathroom_id')
      .notNull()
      .references(() => bathrooms.id, { onDelete: 'cascade' }),
    // One-way hash of the opaque token; the raw token is never persisted (SDD §5).
    tokenHash: text('token_hash').notNull(),
    status: qrTokenStatus('status').notNull().default('active'),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('qr_tokens_token_hash_key').on(table.tokenHash)],
);

export const users = pgTable(
  'users',
  {
    id: id(),
    // Identity anchor from Cognito. Null only for an invited-but-unlinked record;
    // the invite bridge (SDD §3.3) sets it when the invitee first authenticates.
    cognitoSub: text('cognito_sub'),
    phone: text('phone'),
    status: userStatus('status').notNull().default('active'),
    platformRole: platformRoleName('platform_role').notNull().default('member'),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('users_cognito_sub_key').on(table.cognitoSub)],
);

export const siteRoles = pgTable(
  'site_roles',
  {
    id: id(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    // Null while an invite is pending link to a Cognito identity (SDD §3.3, §4.1).
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // Identifier a manager invited by, used to link the pending role on first login.
    invitedPhone: text('invited_phone'),
    role: siteRoleName('role').notNull(),
    status: siteRoleStatus('status').notNull().default('pending'),
    maxAuthorizationCents: integer('max_authorization_cents'),
    // Null = every bathroom in the site; otherwise an allow-list of bathroom ids.
    bathroomScope: jsonb('bathroom_scope').$type<string[]>(),
    createdAt: createdAt(),
  },
  (table) => [
    // Partial: excludes revoked rows (Phase 8 fix) so a revoked role does not permanently
    // occupy the (site, user) slot -- a revoked identity can be re-invited and reactivated
    // at the same site, with the revoked row kept as history. Enforces the real invariant:
    // at most one ACTIVE role per user per site, not "at most one role ever".
    uniqueIndex('site_roles_site_user_key')
      .on(table.siteId, table.userId)
      .where(sql`${table.status} <> 'revoked'`),
  ],
);

export const cleaningRequests = pgTable(
  'cleaning_requests',
  {
    id: id(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    bathroomId: uuid('bathroom_id')
      .notNull()
      .references(() => bathrooms.id, { onDelete: 'cascade' }),
    requestedByUserId: uuid('requested_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // Server-derived price snapshot so later Site price changes cannot alter it (SDD §4.1, §8).
    priceVersion: integer('price_version').notNull(),
    amountCents: integer('amount_cents').notNull(),
    status: cleaningRequestStatus('status').notNull().default('authorizing'),
    createdAt: createdAt(),
  },
  (table) => [
    // Duplicate-active-request guard backstop (SDD §9.4): at most one non-terminal
    // request per bathroom. The app checks this before any gateway call; this partial
    // unique index makes a true double-tap race impossible to write twice.
    uniqueIndex('cleaning_requests_bathroom_active_key')
      .on(table.bathroomId)
      .where(sql`${table.status} IN ('authorizing', 'authorized')`),
  ],
);

export const paymentAuthorizations = pgTable(
  'payment_authorizations',
  {
    id: id(),
    // 1:1 with a request in the MVP (SDD §4.1); enforced by the unique index below.
    requestId: uuid('request_id')
      .notNull()
      .references(() => cleaningRequests.id, { onDelete: 'cascade' }),
    stripePaymentIntentId: text('stripe_payment_intent_id').notNull(),
    status: paymentAuthorizationStatus('status').notNull().default('requires_capture'),
    amountCents: integer('amount_cents').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('payment_auth_request_key').on(table.requestId),
    uniqueIndex('payment_auth_intent_key').on(table.stripePaymentIntentId),
  ],
);

// Mock-only saved payment method (SDD §9.4). Belongs to the Site, not the User who added
// it -- see docs/phase3-saved-payment-method-plan.md for the rationale. At most one per
// Site in this phase (unique on site_id). `displayLabel` is always a fixed mock string
// (e.g. "Mock Visa •••• 4242"), never a real-looking free-text PAN; `gatewayToken` is
// prefixed `mock_pm_` so it can never be mistaken for a real Stripe payment-method id.
export const sitePaymentMethods = pgTable(
  'site_payment_methods',
  {
    id: id(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    gatewayToken: text('gateway_token').notNull(),
    displayLabel: text('display_label').notNull(),
    // Audit only -- does not change who the method belongs to (the Site) or who may use it.
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('site_payment_methods_site_key').on(table.siteId)],
);

// An authorized user's over-limit request awaiting a manager's approval (SDD §10).
// Renamed from assistant_approval_requests in Phase 6 (assistant -> authorized_user).
export const requestApprovals = pgTable('request_approvals', {
  id: id(),
  siteId: uuid('site_id')
    .notNull()
    .references(() => sites.id, { onDelete: 'cascade' }),
  bathroomId: uuid('bathroom_id')
    .notNull()
    .references(() => bathrooms.id, { onDelete: 'cascade' }),
  requesterUserId: uuid('requester_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Bound values: changing any of these invalidates a prior approval (SDD §10).
  priceVersion: integer('price_version').notNull(),
  amountCents: integer('amount_cents').notNull(),
  status: approvalStatus('status').notNull().default('pending'),
  approvedByUserId: uuid('approved_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const publicAlerts = pgTable('public_alerts', {
  id: id(),
  bathroomId: uuid('bathroom_id')
    .notNull()
    .references(() => bathrooms.id, { onDelete: 'cascade' }),
  note: text('note'),
  createdAt: createdAt(),
});

// Demo-only (SDD §6.3): a single-use invite code bound to one pending SiteRole.
// Present in every environment but written/read only when DEMO_MODE is on; it
// lets the invite -> accept -> activation loop be walked without live SMS/Cognito.
// It confers no authority itself -- acceptance reuses the §3.3 bridge unchanged.
export const demoInviteCodes = pgTable(
  'demo_invite_codes',
  {
    id: id(),
    siteRoleId: uuid('site_role_id')
      .notNull()
      .references(() => siteRoles.id, { onDelete: 'cascade' }),
    // The opaque, human-typable code handed to the invitee (unique across the table).
    code: text('code').notNull(),
    // Set the moment the code is claimed; a non-null value means it is spent (single-use).
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('demo_invite_codes_code_key').on(table.code)],
);

export const siteRelations = relations(sites, ({ many }) => ({
  bathrooms: many(bathrooms),
  roles: many(siteRoles),
}));

export const bathroomRelations = relations(bathrooms, ({ one, many }) => ({
  site: one(sites, { fields: [bathrooms.siteId], references: [sites.id] }),
  qrTokens: many(qrTokens),
}));

export const siteRoleRelations = relations(siteRoles, ({ one }) => ({
  site: one(sites, { fields: [siteRoles.siteId], references: [sites.id] }),
  user: one(users, { fields: [siteRoles.userId], references: [users.id] }),
}));

export type SiteRow = typeof sites.$inferSelect;
export type BathroomRow = typeof bathrooms.$inferSelect;
export type QrTokenRow = typeof qrTokens.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type SiteRoleRow = typeof siteRoles.$inferSelect;
export type CleaningRequestRow = typeof cleaningRequests.$inferSelect;
export type PaymentAuthorizationRow = typeof paymentAuthorizations.$inferSelect;
export type SitePaymentMethodRow = typeof sitePaymentMethods.$inferSelect;
export type RequestApprovalRow = typeof requestApprovals.$inferSelect;
export type PublicAlertRow = typeof publicAlerts.$inferSelect;
export type DemoInviteCodeRow = typeof demoInviteCodes.$inferSelect;
