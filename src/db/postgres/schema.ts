import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const workspaceVisibility = pgEnum("workspace_visibility", ["private", "link", "public"]);
export const workspaceRole = pgEnum("workspace_role", ["owner", "editor", "viewer"]);
export const sharePermission = pgEnum("share_permission", ["view", "copy"]);
export const workspaceMode = pgEnum("workspace_mode", [
  "question_bank",
  "study_material",
  "mixed",
  "unknown",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("users_email_unique").on(table.email)]);

export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("auth_sessions_token_hash_unique").on(table.token),
  index("auth_sessions_user_expires_idx").on(table.userId, table.expiresAt),
]);

export const authAccounts = pgTable("auth_accounts", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  issuer: text("issuer").notNull(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token_ciphertext"),
  refreshToken: text("refresh_token_ciphertext"),
  idToken: text("id_token_ciphertext"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("auth_accounts_issuer_unique").on(table.issuer, table.accountId),
  index("auth_accounts_user_idx").on(table.userId),
]);

export const authVerifications = pgTable("auth_verifications", {
  id: uuid("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("auth_verifications_identifier_expires_idx").on(table.identifier, table.expiresAt)]);

export const learners = pgTable("learners", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  mergedIntoId: uuid("merged_into_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("learners_user_id_unique").on(table.userId).where(sql`user_id IS NOT NULL`),
]);

export const guestSessions = pgTable("guest_sessions", {
  id: uuid("id").primaryKey(),
  learnerId: uuid("learner_id").notNull().references(() => learners.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  claimedByUserId: uuid("claimed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("guest_sessions_token_hash_unique").on(table.tokenHash),
  uniqueIndex("guest_sessions_learner_unique").on(table.learnerId),
  index("guest_sessions_expires_at_idx").on(table.expiresAt),
]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  visibility: workspaceVisibility("visibility").notNull().default("private"),
  createdByLearnerId: uuid("created_by_learner_id").notNull().references(() => learners.id),
  detectedMode: workspaceMode("detected_mode").notNull().default("unknown"),
  manualMode: workspaceMode("manual_mode"),
  idempotencyKey: text("idempotency_key"),
  createRequestHash: text("create_request_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("workspaces_slug_unique").on(table.slug),
  uniqueIndex("workspaces_creator_idempotency_unique")
    .on(table.createdByLearnerId, table.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
  index("workspaces_visibility_created_idx").on(table.visibility, table.createdAt),
]);

export const workspaceMembers = pgTable("workspace_members", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  learnerId: uuid("learner_id").notNull().references(() => learners.id, { onDelete: "cascade" }),
  role: workspaceRole("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.learnerId] }),
  index("workspace_members_learner_idx").on(table.learnerId),
  uniqueIndex("workspace_members_single_owner").on(table.workspaceId).where(sql`role = 'owner'`),
]);

export const workspaceShares = pgTable("workspace_shares", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  permission: sharePermission("permission").notNull().default("view"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("workspace_shares_token_hash_unique").on(table.tokenHash),
  index("workspace_shares_workspace_idx").on(table.workspaceId),
]);

export const legacyBankMappings = pgTable("legacy_bank_mappings", {
  legacyBankId: text("legacy_bank_id").primaryKey(),
  legacySlug: text("legacy_slug").notNull(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerKeyHash: text("owner_key_hash").notNull(),
  checksum: text("checksum").notNull(),
  migratedAt: timestamp("migrated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("legacy_bank_mappings_slug_unique").on(table.legacySlug),
  uniqueIndex("legacy_bank_mappings_workspace_unique").on(table.workspaceId),
]);

export const postgresSchema = {
  users,
  authSessions,
  authAccounts,
  authVerifications,
  learners,
  guestSessions,
  workspaces,
  workspaceMembers,
  workspaceShares,
  legacyBankMappings,
};
