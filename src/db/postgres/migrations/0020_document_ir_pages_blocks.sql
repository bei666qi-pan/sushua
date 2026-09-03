CREATE TYPE document_block_type AS ENUM (
  'heading',
  'paragraph',
  'list',
  'list_item',
  'table',
  'table_cell',
  'formula',
  'image',
  'question_candidate',
  'answer_candidate',
  'text',
  'unknown'
);

CREATE TABLE pages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  page_number integer NOT NULL,
  width double precision NOT NULL,
  height double precision NOT NULL,
  rendered_image_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pages_id_uuidv7 CHECK (substring(id::text FROM 15 FOR 1) = '7'),
  CONSTRAINT pages_page_number_positive CHECK (page_number >= 1),
  CONSTRAINT pages_dimensions_positive CHECK (width > 0 AND height > 0),
  CONSTRAINT pages_rendered_image_key_tenant_prefix CHECK (
    rendered_image_key IS NULL OR (
      rendered_image_key LIKE 'tenant/' || workspace_id::text || '/%'
      AND rendered_image_key !~ '(^|/)\.\.?(/|$)'
    )
  ),
  CONSTRAINT pages_version_fk FOREIGN KEY (workspace_id, document_version_id)
    REFERENCES document_versions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT pages_workspace_version_id_unique UNIQUE (workspace_id, document_version_id, id),
  CONSTRAINT pages_version_page_number_unique UNIQUE (document_version_id, page_number)
);
CREATE INDEX pages_workspace_version_page_idx
  ON pages(workspace_id, document_version_id, page_number);

CREATE TABLE blocks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  page_id uuid NOT NULL,
  parent_block_id uuid,
  block_type document_block_type NOT NULL,
  text text,
  markdown text,
  bbox jsonb NOT NULL,
  reading_order integer NOT NULL,
  confidence double precision NOT NULL,
  heading_level smallint,
  table_structure jsonb,
  formula_latex text,
  image_object_key text,
  source_hash char(64) NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blocks_id_uuidv7 CHECK (substring(id::text FROM 15 FOR 1) = '7'),
  CONSTRAINT blocks_reading_order_nonnegative CHECK (reading_order >= 0),
  CONSTRAINT blocks_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT blocks_source_hash_format CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT blocks_not_own_parent CHECK (parent_block_id IS DISTINCT FROM id),
  CONSTRAINT blocks_heading_level CHECK (
    (block_type = 'heading' AND heading_level BETWEEN 1 AND 6)
    OR (block_type <> 'heading' AND heading_level IS NULL)
  ),
  CONSTRAINT blocks_bbox_normalized CHECK (
    CASE WHEN jsonb_typeof(bbox) = 'array'
      AND jsonb_array_length(bbox) = 4
      AND jsonb_typeof(bbox -> 0) = 'number'
      AND jsonb_typeof(bbox -> 1) = 'number'
      AND jsonb_typeof(bbox -> 2) = 'number'
      AND jsonb_typeof(bbox -> 3) = 'number'
    THEN
      (bbox ->> 0)::double precision >= 0
      AND (bbox ->> 1)::double precision >= 0
      AND (bbox ->> 2)::double precision > 0
      AND (bbox ->> 3)::double precision > 0
      AND (bbox ->> 0)::double precision + (bbox ->> 2)::double precision <= 1
      AND (bbox ->> 1)::double precision + (bbox ->> 3)::double precision <= 1
    ELSE false END
  ),
  CONSTRAINT blocks_image_object_key_tenant_prefix CHECK (
    image_object_key IS NULL OR (
      image_object_key LIKE 'tenant/' || workspace_id::text || '/%'
      AND image_object_key !~ '(^|/)\.\.?(/|$)'
    )
  ),
  CONSTRAINT blocks_version_fk FOREIGN KEY (workspace_id, document_version_id)
    REFERENCES document_versions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT blocks_page_fk FOREIGN KEY (workspace_id, document_version_id, page_id)
    REFERENCES pages(workspace_id, document_version_id, id) ON DELETE CASCADE,
  CONSTRAINT blocks_parent_fk FOREIGN KEY (workspace_id, document_version_id, parent_block_id)
    REFERENCES blocks(workspace_id, document_version_id, id) ON DELETE RESTRICT,
  CONSTRAINT blocks_workspace_version_id_unique UNIQUE (workspace_id, document_version_id, id),
  CONSTRAINT blocks_page_reading_order_unique UNIQUE (page_id, reading_order)
);
CREATE INDEX blocks_workspace_version_page_idx
  ON blocks(workspace_id, document_version_id, page_id);
CREATE INDEX blocks_source_hash_idx ON blocks(source_hash);
CREATE INDEX blocks_active_idx
  ON blocks(workspace_id, document_version_id, page_id, reading_order)
  WHERE deleted_at IS NULL;

ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE pages FORCE ROW LEVEL SECURITY;
CREATE POLICY pages_member_select ON pages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = pages.workspace_id
      AND wm.learner_id = app_current_learner_id()
  )
);
CREATE POLICY pages_editor_insert ON pages FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = pages.workspace_id
      AND wm.learner_id = app_current_learner_id()
      AND wm.role IN ('owner', 'editor')
  )
);

ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocks FORCE ROW LEVEL SECURITY;
CREATE POLICY blocks_member_select ON blocks FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = blocks.workspace_id
      AND wm.learner_id = app_current_learner_id()
  )
);
CREATE POLICY blocks_editor_insert ON blocks FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = blocks.workspace_id
      AND wm.learner_id = app_current_learner_id()
      AND wm.role IN ('owner', 'editor')
  )
);
