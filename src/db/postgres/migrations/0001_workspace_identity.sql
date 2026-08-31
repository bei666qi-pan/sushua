CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE workspace_visibility AS ENUM ('private', 'link', 'public');
CREATE TYPE workspace_role AS ENUM ('owner', 'editor', 'viewer');
CREATE TYPE share_permission AS ENUM ('view', 'copy');
CREATE TYPE workspace_mode AS ENUM ('question_bank', 'study_material', 'mixed', 'unknown');

CREATE TABLE users (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_email_normalized CHECK (email = lower(email))
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
  ,CONSTRAINT auth_sessions_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX auth_sessions_user_expires_idx ON auth_sessions(user_id, expires_at);

CREATE TABLE auth_accounts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_accounts_provider_unique UNIQUE (provider_id, account_id)
);
CREATE INDEX auth_accounts_user_idx ON auth_accounts(user_id);

CREATE TABLE auth_verifications (
  id uuid PRIMARY KEY,
  identifier text NOT NULL,
  value_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
  ,CONSTRAINT auth_verifications_value_hash_format CHECK (value_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX auth_verifications_identifier_expires_idx ON auth_verifications(identifier, expires_at);

CREATE TABLE learners (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  merged_into_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learners_merged_into_not_self CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);
ALTER TABLE learners
  ADD CONSTRAINT learners_merged_into_fk
  FOREIGN KEY (merged_into_id) REFERENCES learners(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX learners_user_id_unique ON learners(user_id) WHERE user_id IS NOT NULL;

CREATE TABLE guest_sessions (
  id uuid PRIMARY KEY,
  learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guest_sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT guest_sessions_learner_unique UNIQUE (learner_id),
  CONSTRAINT guest_sessions_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX guest_sessions_expires_at_idx ON guest_sessions(expires_at);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  slug text NOT NULL,
  title text NOT NULL,
  visibility workspace_visibility NOT NULL DEFAULT 'private',
  created_by_learner_id uuid NOT NULL REFERENCES learners(id),
  detected_mode workspace_mode NOT NULL DEFAULT 'unknown',
  manual_mode workspace_mode,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT workspaces_slug_unique UNIQUE (slug),
  CONSTRAINT workspaces_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,62}$')
);
CREATE INDEX workspaces_created_by_idx ON workspaces(created_by_learner_id);
CREATE INDEX workspaces_visibility_created_idx ON workspaces(visibility, created_at, id);
CREATE INDEX workspaces_active_idx ON workspaces(created_at, id) WHERE deleted_at IS NULL;

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  learner_id uuid NOT NULL REFERENCES learners(id) ON DELETE CASCADE,
  role workspace_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, learner_id)
);
CREATE INDEX workspace_members_learner_idx ON workspace_members(learner_id, workspace_id);
CREATE UNIQUE INDEX workspace_members_single_owner ON workspace_members(workspace_id) WHERE role = 'owner';

CREATE TABLE workspace_shares (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  permission share_permission NOT NULL DEFAULT 'view',
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_shares_workspace_idx ON workspace_shares(workspace_id);

CREATE TABLE legacy_bank_mappings (
  legacy_bank_id text PRIMARY KEY,
  legacy_slug text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_key_hash text NOT NULL,
  checksum char(64) NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legacy_bank_mappings_checksum_format CHECK (checksum ~ '^[0-9a-f]{64}$')
);

CREATE OR REPLACE FUNCTION app_current_learner_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.learner_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_current_workspace_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;

ALTER TABLE learners ENABLE ROW LEVEL SECURITY;
ALTER TABLE learners FORCE ROW LEVEL SECURITY;
CREATE POLICY learners_self_select ON learners FOR SELECT
  USING (id = app_current_learner_id());
CREATE POLICY learners_self_insert ON learners FOR INSERT
  WITH CHECK (id = app_current_learner_id() AND user_id IS NULL AND merged_into_id IS NULL);
CREATE POLICY learners_self_update ON learners FOR UPDATE
  USING (id = app_current_learner_id())
  WITH CHECK (id = app_current_learner_id());

ALTER TABLE guest_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY guest_sessions_self_select ON guest_sessions FOR SELECT
  USING (learner_id = app_current_learner_id());
CREATE POLICY guest_sessions_self_insert ON guest_sessions FOR INSERT
  WITH CHECK (learner_id = app_current_learner_id());
CREATE POLICY guest_sessions_self_update ON guest_sessions FOR UPDATE
  USING (learner_id = app_current_learner_id())
  WITH CHECK (learner_id = app_current_learner_id());
CREATE POLICY guest_sessions_self_delete ON guest_sessions FOR DELETE
  USING (learner_id = app_current_learner_id());

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_members_self_select ON workspace_members FOR SELECT
  USING (
    learner_id = app_current_learner_id()
    AND (app_current_workspace_id() IS NULL OR workspace_id = app_current_workspace_id())
  );
CREATE POLICY workspace_members_initial_owner_insert ON workspace_members FOR INSERT
  WITH CHECK (
    learner_id = app_current_learner_id()
    AND role = 'owner'
    AND (app_current_workspace_id() IS NULL OR workspace_id = app_current_workspace_id())
    AND EXISTS (
      SELECT 1 FROM workspaces w
      WHERE w.id = workspace_id AND w.created_by_learner_id = app_current_learner_id()
    )
  );
CREATE POLICY workspace_members_self_delete ON workspace_members FOR DELETE
  USING (learner_id = app_current_learner_id());

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_visible_select ON workspaces FOR SELECT
  USING (
    deleted_at IS NULL
    AND (app_current_workspace_id() IS NULL OR id = app_current_workspace_id())
    AND (
      visibility = 'public'
      OR created_by_learner_id = app_current_learner_id()
      OR EXISTS (
        SELECT 1 FROM workspace_members wm
        WHERE wm.workspace_id = id AND wm.learner_id = app_current_learner_id()
      )
    )
  );
CREATE POLICY workspaces_owner_insert ON workspaces FOR INSERT
  WITH CHECK (created_by_learner_id = app_current_learner_id());
CREATE POLICY workspaces_owner_update ON workspaces FOR UPDATE
  USING (
    created_by_learner_id = app_current_learner_id()
    AND (app_current_workspace_id() IS NULL OR id = app_current_workspace_id())
  )
  WITH CHECK (created_by_learner_id = app_current_learner_id());
CREATE POLICY workspaces_owner_delete ON workspaces FOR DELETE
  USING (created_by_learner_id = app_current_learner_id());

ALTER TABLE workspace_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_shares_owner_all ON workspace_shares FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM workspaces w
      WHERE w.id = workspace_id AND w.created_by_learner_id = app_current_learner_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspaces w
      WHERE w.id = workspace_id AND w.created_by_learner_id = app_current_learner_id()
    )
  );

ALTER TABLE legacy_bank_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_bank_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY legacy_bank_mappings_workspace_select ON legacy_bank_mappings FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM workspaces w
      WHERE w.id = workspace_id
    )
  );
CREATE POLICY legacy_bank_mappings_owner_write ON legacy_bank_mappings FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM workspaces w
      WHERE w.id = workspace_id AND w.created_by_learner_id = app_current_learner_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspaces w
      WHERE w.id = workspace_id AND w.created_by_learner_id = app_current_learner_id()
    )
  );
