ALTER TABLE blocks ADD CONSTRAINT blocks_workspace_id_unique UNIQUE (workspace_id, id);

CREATE TABLE document_revisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  document_id uuid NOT NULL,
  base_document_version_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  created_by_learner_id uuid NOT NULL REFERENCES learners(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_revisions_id_uuidv7 CHECK (substring(id::text FROM 15 FOR 1) = '7'),
  CONSTRAINT document_revisions_document_fk FOREIGN KEY (workspace_id, document_id)
    REFERENCES documents(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT document_revisions_base_version_fk FOREIGN KEY (workspace_id, document_id, base_document_version_id)
    REFERENCES document_versions(workspace_id, document_id, id),
  CONSTRAINT document_revisions_workspace_revision_unique UNIQUE (workspace_id, document_id, revision_number),
  CONSTRAINT document_revisions_workspace_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT document_revisions_workspace_base_version_id_unique UNIQUE (workspace_id, id, base_document_version_id)
);

CREATE TABLE document_revision_blocks (
  revision_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  base_document_version_id uuid NOT NULL,
  source_block_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('edit','delete','split','merge')),
  patch jsonb NOT NULL CHECK (jsonb_typeof(patch) = 'object'),
  PRIMARY KEY (revision_id, source_block_id),
  CONSTRAINT document_revision_blocks_revision_fk FOREIGN KEY (workspace_id, revision_id, base_document_version_id)
    REFERENCES document_revisions(workspace_id, id, base_document_version_id) ON DELETE CASCADE,
  CONSTRAINT document_revision_blocks_source_fk FOREIGN KEY (workspace_id, base_document_version_id, source_block_id)
    REFERENCES blocks(workspace_id, document_version_id, id) ON DELETE RESTRICT
);

CREATE INDEX document_revisions_created_by_learner_idx
  ON document_revisions(created_by_learner_id);
CREATE INDEX document_revisions_document_base_version_idx
  ON document_revisions(workspace_id, document_id, base_document_version_id);
CREATE INDEX document_revision_blocks_revision_idx
  ON document_revision_blocks(workspace_id, revision_id, base_document_version_id);
CREATE INDEX document_revision_blocks_source_idx
  ON document_revision_blocks(workspace_id, base_document_version_id, source_block_id);

ALTER TABLE document_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY document_revisions_member_select ON document_revisions FOR SELECT USING (EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=document_revisions.workspace_id AND wm.learner_id=app_current_learner_id()));
CREATE POLICY document_revisions_editor_insert ON document_revisions FOR INSERT WITH CHECK (created_by_learner_id=app_current_learner_id() AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=document_revisions.workspace_id AND wm.learner_id=app_current_learner_id() AND wm.role IN ('owner','editor')));
ALTER TABLE document_revision_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_revision_blocks FORCE ROW LEVEL SECURITY;
CREATE POLICY document_revision_blocks_member_select ON document_revision_blocks FOR SELECT USING (EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=document_revision_blocks.workspace_id AND wm.learner_id=app_current_learner_id()));
CREATE POLICY document_revision_blocks_editor_insert ON document_revision_blocks FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=document_revision_blocks.workspace_id AND wm.learner_id=app_current_learner_id() AND wm.role IN ('owner','editor')));
