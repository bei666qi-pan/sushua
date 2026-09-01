import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
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
export const jobType = pgEnum("job_type", ["file.scan", "document.parse", "document.cleanup"]);
export const jobState = pgEnum("job_state", [
  "queued",
  "running",
  "succeeded",
  "partially_succeeded",
  "failed",
  "dead_lettered",
  "cancel_requested",
  "cancelled",
]);
export const documentParseStatus = pgEnum("document_parse_status", [
  "uploading",
  "scan_pending",
  "parsing",
  "ready",
  "failed",
]);
export const documentVersionStatus = pgEnum("document_version_status", [
  "uploading",
  "scan_pending",
  "scanned",
  "parsing",
  "ready",
  "failed",
]);
export const sourceAssetKind = pgEnum("source_asset_kind", [
  "original",
  "rendered_page",
  "block_image",
  "formula",
  "embedded",
]);
export const sourceAssetScanStatus = pgEnum("source_asset_scan_status", [
  "pending",
  "clean",
  "infected",
  "failed",
]);
export const sourceAssetUploadState = pgEnum("source_asset_upload_state", [
  "initiated",
  "uploaded",
  "aborted",
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
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  claimedByLearnerId: uuid("claimed_by_learner_id").references(() => learners.id, { onDelete: "set null" }),
}, (table) => [
  uniqueIndex("legacy_bank_mappings_slug_unique").on(table.legacySlug),
  uniqueIndex("legacy_bank_mappings_workspace_unique").on(table.workspaceId),
  index("legacy_bank_mappings_claimed_by_idx")
    .on(table.claimedByLearnerId)
    .where(sql`claimed_by_learner_id IS NOT NULL`),
]);

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey(),
  schemaVersion: smallint("schema_version").notNull().default(1),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  learnerId: uuid("learner_id").references(() => learners.id, { onDelete: "set null" }),
  resourceId: uuid("resource_id").notNull(),
  type: jobType("type").notNull(),
  state: jobState("state").notNull().default("queued"),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  traceId: uuid("trace_id").notNull(),
  priority: smallint("priority").notNull().default(0),
  budget: jsonb("budget").notNull().default({}),
  progress: jsonb("progress").notNull(),
  checkpoint: jsonb("checkpoint"),
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull(),
  runAfter: timestamp("run_after", { withTimezone: true }).notNull(),
  timeoutAt: timestamp("timeout_at", { withTimezone: true }),
  errorCode: text("error_code"),
  cancelReason: text("cancel_reason"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("jobs_workspace_type_idempotency_unique").on(table.workspaceId, table.type, table.idempotencyKey),
  index("jobs_workspace_created_idx").on(table.workspaceId, table.requestedAt, table.id),
  index("jobs_runnable_idx")
    .on(table.state, table.runAfter, table.priority, table.requestedAt, table.id)
    .where(sql`state IN ('queued', 'cancel_requested')`),
]);

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sha256: text("sha256").notNull(),
  language: text("language"),
  detectedMode: workspaceMode("detected_mode").notNull().default("unknown"),
  manualMode: workspaceMode("manual_mode"),
  parseStatus: documentParseStatus("parse_status").notNull().default("uploading"),
  currentVersionId: uuid("current_version_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("documents_workspace_id_unique").on(table.workspaceId, table.id),
  uniqueIndex("documents_workspace_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
  index("documents_workspace_created_idx").on(table.workspaceId, table.createdAt, table.id),
  index("documents_active_idx").on(table.workspaceId, table.createdAt, table.id).where(sql`deleted_at IS NULL`),
]);

export const documentVersions = pgTable("document_versions", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  sourceObjectKey: text("source_object_key").notNull(),
  contentHash: text("content_hash").notNull(),
  parseConfig: jsonb("parse_config").notNull().default({}),
  irSchemaVersion: text("ir_schema_version").notNull().default("sushua.document-ir.v1"),
  status: documentVersionStatus("status").notNull().default("uploading"),
  errorCode: text("error_code"),
  parseJobId: uuid("parse_job_id").references(() => jobs.id),
  irObjectKey: text("ir_object_key"),
  irSha256: text("ir_sha256"),
  parser: text("parser"),
  parserVersion: text("parser_version"),
  pageCount: integer("page_count"),
  parsedAt: timestamp("parsed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("document_versions_document_version_unique").on(table.documentId, table.version),
  uniqueIndex("document_versions_document_hash_unique").on(table.documentId, table.contentHash),
  uniqueIndex("document_versions_workspace_document_id_unique").on(table.workspaceId, table.documentId, table.id),
  uniqueIndex("document_versions_workspace_id_unique").on(table.workspaceId, table.id),
  index("document_versions_document_created_idx").on(table.documentId, table.createdAt, table.id),
  index("document_versions_parse_job_idx").on(table.parseJobId).where(sql`parse_job_id IS NOT NULL`),
]);

export const sourceAssets = pgTable("source_assets", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  documentVersionId: uuid("document_version_id").notNull().references(() => documentVersions.id, { onDelete: "cascade" }),
  kind: sourceAssetKind("kind").notNull(),
  objectKey: text("object_key").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  scanStatus: sourceAssetScanStatus("scan_status").notNull().default("pending"),
  storageUploadId: text("storage_upload_id"),
  uploadExpiresAt: timestamp("upload_expires_at", { withTimezone: true }),
  uploadState: sourceAssetUploadState("upload_state"),
  uploadCompletedAt: timestamp("upload_completed_at", { withTimezone: true }),
  completionIdempotencyKey: text("completion_idempotency_key"),
  completionRequestHash: text("completion_request_hash"),
  scanJobId: uuid("scan_job_id").references(() => jobs.id),
  scannedSha256: text("scanned_sha256"),
  scanSignature: text("scan_signature"),
  scanErrorCode: text("scan_error_code"),
  scannedAt: timestamp("scanned_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("source_assets_workspace_object_unique").on(table.workspaceId, table.objectKey),
  uniqueIndex("source_assets_workspace_upload_unique")
    .on(table.workspaceId, table.storageUploadId)
    .where(sql`storage_upload_id IS NOT NULL`),
  index("source_assets_version_idx").on(table.documentVersionId, table.id),
  index("source_assets_hash_idx").on(table.workspaceId, table.sha256),
  index("source_assets_scan_job_idx").on(table.scanJobId).where(sql`scan_job_id IS NOT NULL`),
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
  jobs,
  documents,
  documentVersions,
  sourceAssets,
};
