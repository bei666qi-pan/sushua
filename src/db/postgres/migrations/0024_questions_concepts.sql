CREATE TYPE concept_status AS ENUM ('draft', 'ready', 'archived');
CREATE TYPE question_origin AS ENUM ('user', 'ai', 'legacy', 'variant');
CREATE TYPE question_type AS ENUM (
  'single_choice', 'multiple_choice', 'true_false', 'fill_blank',
  'short_answer', 'essay', 'calculation', 'matching', 'other'
);
CREATE TYPE question_status AS ENUM ('draft', 'ready', 'archived');
CREATE TYPE cognitive_level AS ENUM ('remember', 'understand', 'apply', 'analyze', 'evaluate', 'create');
CREATE TYPE source_relation AS ENUM ('defines', 'explains', 'mentions', 'supports_stem', 'supports_answer', 'supports_explanation');

ALTER TABLE blocks
  ADD CONSTRAINT blocks_workspace_version_page_id_unique
  UNIQUE (workspace_id, document_version_id, page_id, id);
ALTER TABLE blocks
  ADD CONSTRAINT blocks_workspace_version_page_block_source_unique
  UNIQUE (workspace_id, document_version_id, page_id, id, source_hash);

CREATE TABLE concepts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  normalized_name text NOT NULL,
  description text,
  status concept_status NOT NULL DEFAULT 'draft',
  created_by_learner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT concepts_id_uuidv7 CHECK (substring(id::text FROM 15 FOR 1) = '7'),
  CONSTRAINT concepts_name_length CHECK (length(name) BETWEEN 1 AND 300),
  CONSTRAINT concepts_normalized_name CHECK (normalized_name = lower(normalized_name) AND length(normalized_name) BETWEEN 1 AND 300),
  CONSTRAINT concepts_workspace_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT concepts_workspace_normalized_name_unique UNIQUE (workspace_id, normalized_name),
  CONSTRAINT concepts_created_by_member_fk FOREIGN KEY (workspace_id, created_by_learner_id)
    REFERENCES workspace_members(workspace_id, learner_id) ON DELETE RESTRICT
);
CREATE INDEX concepts_workspace_status_created_idx ON concepts(workspace_id, status, created_at, id);

CREATE TABLE concept_sources (
  concept_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  block_id uuid NOT NULL,
  relation source_relation NOT NULL CHECK (relation IN ('defines', 'explains', 'mentions')),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  PRIMARY KEY (concept_id, block_id, relation),
  CONSTRAINT concept_sources_concept_fk FOREIGN KEY (workspace_id, concept_id)
    REFERENCES concepts(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT concept_sources_block_fk FOREIGN KEY (workspace_id, document_version_id, block_id)
    REFERENCES blocks(workspace_id, document_version_id, id) ON DELETE RESTRICT
);
CREATE INDEX concept_sources_block_idx ON concept_sources(workspace_id, document_version_id, block_id);

CREATE TABLE questions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  origin question_origin NOT NULL,
  parent_question_id uuid,
  type question_type NOT NULL,
  status question_status NOT NULL DEFAULT 'draft',
  current_version_id uuid,
  created_by_learner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT questions_id_uuidv7 CHECK (substring(id::text FROM 15 FOR 1) = '7'),
  CONSTRAINT questions_parent_not_self CHECK (parent_question_id IS NULL OR parent_question_id <> id),
  CONSTRAINT questions_workspace_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT questions_parent_fk FOREIGN KEY (workspace_id, parent_question_id)
    REFERENCES questions(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT questions_created_by_member_fk FOREIGN KEY (workspace_id, created_by_learner_id)
    REFERENCES workspace_members(workspace_id, learner_id) ON DELETE RESTRICT
);
CREATE INDEX questions_workspace_status_created_idx ON questions(workspace_id, status, created_at, id);
CREATE INDEX questions_parent_idx ON questions(workspace_id, parent_question_id) WHERE parent_question_id IS NOT NULL;

CREATE TABLE question_versions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  question_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  stem text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer jsonb NOT NULL,
  rubric jsonb NOT NULL DEFAULT '{}'::jsonb,
  explanation text,
  difficulty smallint NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  cognitive_level cognitive_level NOT NULL,
  chapter text,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  generator_model text,
  prompt_version text,
  ai_generation_id uuid,
  created_by_learner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_versions_id_uuidv7 CHECK (substring(id::text FROM 15 FOR 1) = '7'),
  CONSTRAINT question_versions_stem_length CHECK (length(stem) BETWEEN 1 AND 20000),
  CONSTRAINT question_versions_options_array CHECK (jsonb_typeof(options) = 'array'),
  CONSTRAINT question_versions_answer_array CHECK (jsonb_typeof(answer) = 'array'),
  CONSTRAINT question_versions_rubric_object CHECK (jsonb_typeof(rubric) = 'object'),
  CONSTRAINT question_versions_workspace_question_version_unique UNIQUE (workspace_id, question_id, version),
  CONSTRAINT question_versions_workspace_question_id_unique UNIQUE (workspace_id, question_id, id),
  CONSTRAINT question_versions_workspace_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT question_versions_question_fk FOREIGN KEY (workspace_id, question_id)
    REFERENCES questions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT question_versions_created_by_member_fk FOREIGN KEY (workspace_id, created_by_learner_id)
    REFERENCES workspace_members(workspace_id, learner_id) ON DELETE RESTRICT
);
CREATE INDEX question_versions_question_created_idx ON question_versions(question_id, created_at, id);

ALTER TABLE questions
  ADD CONSTRAINT questions_current_version_fk
  FOREIGN KEY (workspace_id, id, current_version_id)
  REFERENCES question_versions(workspace_id, question_id, id);

CREATE TABLE question_sources (
  question_version_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  page_id uuid NOT NULL,
  block_id uuid NOT NULL,
  bbox jsonb NOT NULL,
  source_quote text NOT NULL,
  source_hash char(64) NOT NULL,
  relation source_relation NOT NULL CHECK (relation IN ('supports_stem', 'supports_answer', 'supports_explanation')),
  PRIMARY KEY (question_version_id, block_id, relation, source_hash),
  CONSTRAINT question_sources_source_hash_format CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT question_sources_quote_length CHECK (length(source_quote) BETWEEN 1 AND 5000),
  CONSTRAINT question_sources_bbox_normalized CHECK (
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
  CONSTRAINT question_sources_question_version_fk FOREIGN KEY (workspace_id, question_version_id)
    REFERENCES question_versions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT question_sources_document_version_fk FOREIGN KEY (workspace_id, document_version_id)
    REFERENCES document_versions(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT question_sources_page_fk FOREIGN KEY (workspace_id, document_version_id, page_id)
    REFERENCES pages(workspace_id, document_version_id, id) ON DELETE RESTRICT,
  CONSTRAINT question_sources_block_page_source_fk FOREIGN KEY (workspace_id, document_version_id, page_id, block_id, source_hash)
    REFERENCES blocks(workspace_id, document_version_id, page_id, id, source_hash) ON DELETE RESTRICT
);
CREATE INDEX question_sources_block_idx ON question_sources(workspace_id, document_version_id, block_id);

CREATE TABLE question_concepts (
  question_version_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  concept_id uuid NOT NULL,
  weight double precision NOT NULL CHECK (weight > 0 AND weight <= 1),
  is_primary boolean NOT NULL DEFAULT false,
  PRIMARY KEY (question_version_id, concept_id),
  CONSTRAINT question_concepts_question_version_fk FOREIGN KEY (workspace_id, question_version_id)
    REFERENCES question_versions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT question_concepts_concept_fk FOREIGN KEY (workspace_id, concept_id)
    REFERENCES concepts(workspace_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX question_concepts_one_primary_idx ON question_concepts(question_version_id) WHERE is_primary;
CREATE INDEX question_concepts_concept_idx ON question_concepts(workspace_id, concept_id, question_version_id);

ALTER TABLE concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE concepts FORCE ROW LEVEL SECURITY;
CREATE POLICY concepts_member_select ON concepts FOR SELECT USING (
  EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = concepts.workspace_id AND wm.learner_id = app_current_learner_id())
);
CREATE POLICY concepts_editor_insert ON concepts FOR INSERT WITH CHECK (
  created_by_learner_id = app_current_learner_id()
  AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = concepts.workspace_id AND wm.learner_id = app_current_learner_id() AND wm.role IN ('owner','editor'))
);

ALTER TABLE concept_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE concept_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY concept_sources_member_select ON concept_sources FOR SELECT USING (
  EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = concept_sources.workspace_id AND wm.learner_id = app_current_learner_id())
);
CREATE POLICY concept_sources_editor_insert ON concept_sources FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = concept_sources.workspace_id AND wm.learner_id = app_current_learner_id() AND wm.role IN ('owner','editor'))
);

ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions FORCE ROW LEVEL SECURITY;
CREATE POLICY questions_member_select ON questions FOR SELECT USING (
  EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = questions.workspace_id AND wm.learner_id = app_current_learner_id())
);
CREATE POLICY questions_editor_insert ON questions FOR INSERT WITH CHECK (
  created_by_learner_id = app_current_learner_id()
  AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = questions.workspace_id AND wm.learner_id = app_current_learner_id() AND wm.role IN ('owner','editor'))
);
CREATE POLICY questions_editor_update ON questions FOR UPDATE USING (
  EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = questions.workspace_id AND wm.learner_id = app_current_learner_id() AND wm.role IN ('owner','editor'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = questions.workspace_id AND wm.learner_id = app_current_learner_id() AND wm.role IN ('owner','editor'))
);

ALTER TABLE question_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY question_versions_member_select ON question_versions FOR SELECT USING (
  EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = question_versions.workspace_id AND wm.learner_id = app_current_learner_id())
);
CREATE POLICY question_versions_editor_insert ON question_versions FOR INSERT WITH CHECK (
  created_by_learner_id = app_current_learner_id()
  AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = question_versions.workspace_id AND wm.learner_id = app_current_learner_id() AND wm.role IN ('owner','editor'))
);

ALTER TABLE question_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY question_sources_member_select ON question_sources FOR SELECT USING (
  EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = question_sources.workspace_id AND wm.learner_id = app_current_learner_id())
);
CREATE POLICY question_sources_editor_insert ON question_sources FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = question_sources.workspace_id AND wm.learner_id = app_current_learner_id() AND wm.role IN ('owner','editor'))
);

ALTER TABLE question_concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_concepts FORCE ROW LEVEL SECURITY;
CREATE POLICY question_concepts_member_select ON question_concepts FOR SELECT USING (
  EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = question_concepts.workspace_id AND wm.learner_id = app_current_learner_id())
);
CREATE POLICY question_concepts_editor_insert ON question_concepts FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = question_concepts.workspace_id AND wm.learner_id = app_current_learner_id() AND wm.role IN ('owner','editor'))
);
