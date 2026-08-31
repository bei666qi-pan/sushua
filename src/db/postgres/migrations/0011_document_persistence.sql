CREATE TYPE document_parse_status AS ENUM ('uploading', 'scan_pending', 'parsing', 'ready', 'failed');
CREATE TYPE document_version_status AS ENUM ('uploading', 'scan_pending', 'scanned', 'parsing', 'ready', 'failed');
CREATE TYPE source_asset_kind AS ENUM ('original', 'rendered_page', 'block_image', 'formula', 'embedded');
CREATE TYPE source_asset_scan_status AS ENUM ('pending', 'clean', 'infected', 'failed');

CREATE TABLE documents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  filename text NOT NULL,
  mime_type text NOT NULL,
  sha256 char(64) NOT NULL,
  language text,
  detected_mode workspace_mode NOT NULL DEFAULT 'unknown',
  manual_mode workspace_mode,
  parse_status document_parse_status NOT NULL DEFAULT 'uploading',
  current_version_id uuid,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CONSTRAINT documents_id_uuidv7 CHECK (substring(id::text FROM 15 FOR 1) = '7'),
  CONSTRAINT documents_filename_safe CHECK (length(filename) BETWEEN 1 AND 255 AND filename !~ '[/\\]'),
  CONSTRAINT documents_mime_type_format CHECK (mime_type ~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$'),
  CONSTRAINT documents_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT documents_idempotency_key_length CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT documents_request_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT documents_workspace_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT documents_workspace_idempotency_unique UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX documents_workspace_created_idx ON documents(workspace_id, created_at, id);
CREATE INDEX documents_active_idx ON documents(workspace_id, created_at, id) WHERE deleted_at IS NULL;

CREATE TABLE document_versions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  source_object_key text NOT NULL,
  content_hash char(64) NOT NULL,
  parse_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ir_schema_version text NOT NULL DEFAULT 'sushua.document-ir.v1',
  status document_version_status NOT NULL DEFAULT 'uploading',
  error_code text,
  created_at timestamptz NOT NULL,
  CONSTRAINT document_versions_id_uuidv7 CHECK (substring(id::text FROM 15 FOR 1) = '7'),
  CONSTRAINT document_versions_content_hash_format CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT document_versions_parse_config_object CHECK (jsonb_typeof(parse_config) = 'object'),
  CONSTRAINT document_versions_document_fk FOREIGN KEY (workspace_id, document_id)
    REFERENCES documents(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT document_versions_document_version_unique UNIQUE (document_id, version),
  CONSTRAINT document_versions_document_hash_unique UNIQUE (document_id, content_hash),
  CONSTRAINT document_versions_workspace_document_id_unique UNIQUE (workspace_id, document_id, id),
  CONSTRAINT document_versions_workspace_id_unique UNIQUE (workspace_id, id)
);
CREATE INDEX document_versions_document_created_idx ON document_versions(document_id, created_at, id);

ALTER TABLE documents ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (workspace_id, id, current_version_id)
  REFERENCES document_versions(workspace_id, document_id, id);

CREATE TABLE source_assets (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  kind source_asset_kind NOT NULL,
  object_key text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 char(64) NOT NULL,
  scan_status source_asset_scan_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL,
  CONSTRAINT source_assets_id_uuidv7 CHECK (substring(id::text FROM 15 FOR 1) = '7'),
  CONSTRAINT source_assets_sha256_format CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT source_assets_mime_type_format CHECK (mime_type ~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$'),
  CONSTRAINT source_assets_object_tenant_prefix CHECK (object_key LIKE 'tenant/' || workspace_id::text || '/%'),
  CONSTRAINT source_assets_version_fk FOREIGN KEY (workspace_id, document_version_id)
    REFERENCES document_versions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT source_assets_workspace_object_unique UNIQUE (workspace_id, object_key)
);
CREATE INDEX source_assets_version_idx ON source_assets(document_version_id, id);
CREATE INDEX source_assets_hash_idx ON source_assets(workspace_id, sha256);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_member_select ON documents FOR SELECT USING (
  deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = documents.workspace_id AND wm.learner_id = app_current_learner_id()
  )
);
CREATE POLICY documents_editor_insert ON documents FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = documents.workspace_id
      AND wm.learner_id = app_current_learner_id()
      AND wm.role IN ('owner', 'editor')
  )
);
CREATE POLICY documents_editor_update ON documents FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = documents.workspace_id
      AND wm.learner_id = app_current_learner_id()
      AND wm.role IN ('owner', 'editor')
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = documents.workspace_id
      AND wm.learner_id = app_current_learner_id()
      AND wm.role IN ('owner', 'editor')
  )
);

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY document_versions_member_select ON document_versions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = document_versions.workspace_id AND wm.learner_id = app_current_learner_id()
  )
);
CREATE POLICY document_versions_editor_insert ON document_versions FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = document_versions.workspace_id
      AND wm.learner_id = app_current_learner_id()
      AND wm.role IN ('owner', 'editor')
  )
);

ALTER TABLE source_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY source_assets_member_select ON source_assets FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = source_assets.workspace_id AND wm.learner_id = app_current_learner_id()
  )
);
CREATE POLICY source_assets_editor_insert ON source_assets FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = source_assets.workspace_id
      AND wm.learner_id = app_current_learner_id()
      AND wm.role IN ('owner', 'editor')
  )
);
