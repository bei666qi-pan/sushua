ALTER TABLE document_versions
  ADD COLUMN ir_indexed_sha256 char(64),
  ADD COLUMN ir_indexed_at timestamptz,
  ADD CONSTRAINT document_versions_ir_index_evidence_complete CHECK (
    num_nonnulls(ir_indexed_sha256, ir_indexed_at) IN (0, 2)
  ),
  ADD CONSTRAINT document_versions_ir_indexed_sha256_format CHECK (
    ir_indexed_sha256 IS NULL OR ir_indexed_sha256 ~ '^[0-9a-f]{64}$'
  );

CREATE OR REPLACE FUNCTION require_document_ir_index_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'ready' AND OLD.status IS DISTINCT FROM 'ready'
    AND (NEW.ir_indexed_sha256 IS NULL OR NEW.ir_indexed_sha256 IS DISTINCT FROM NEW.ir_sha256) THEN
    RAISE EXCEPTION 'document_ir_index_required' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_versions_require_ir_index_before_ready
BEFORE UPDATE OF status ON document_versions
FOR EACH ROW EXECUTE FUNCTION require_document_ir_index_v1();

CREATE OR REPLACE FUNCTION index_document_ir_v1(
  p_job_id uuid,
  p_expected_attempt integer,
  p_ir_sha256 text,
  p_payload jsonb,
  p_indexed_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_version document_versions%ROWTYPE;
  v_pages integer;
  v_blocks integer;
BEGIN
  IF p_expected_attempt < 1
    OR p_ir_sha256 !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_payload) <> 'object'
    OR jsonb_typeof(p_payload -> 'pages') <> 'array'
    OR jsonb_typeof(p_payload -> 'blocks') <> 'array'
    OR p_indexed_at IS NULL OR p_indexed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid_document_ir_index' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND
    OR v_job.type <> 'document.parse'
    OR v_job.state <> 'running'
    OR v_job.attempt <> p_expected_attempt THEN
    RAISE EXCEPTION 'document_ir_index_target_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_version
  FROM document_versions
  WHERE id = v_job.resource_id
    AND workspace_id = v_job.workspace_id
    AND parse_job_id = v_job.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document_ir_index_target_not_found' USING ERRCODE = 'P0001';
  END IF;

  IF v_version.ir_indexed_sha256 IS NOT NULL THEN
    IF v_version.ir_indexed_sha256 IS DISTINCT FROM p_ir_sha256 THEN
      RAISE EXCEPTION 'document_ir_index_conflict' USING ERRCODE = 'P0001';
    END IF;
    SELECT count(*)::integer INTO v_pages FROM pages WHERE document_version_id = v_version.id;
    SELECT count(*)::integer INTO v_blocks FROM blocks WHERE document_version_id = v_version.id;
    IF v_pages <> jsonb_array_length(p_payload -> 'pages')
      OR v_blocks <> jsonb_array_length(p_payload -> 'blocks') THEN
      RAISE EXCEPTION 'document_ir_index_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object('page_count', v_pages, 'block_count', v_blocks, 'replayed', true);
  END IF;

  IF v_version.status <> 'parsing' THEN
    RAISE EXCEPTION 'document_ir_index_state_conflict' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO pages(id, workspace_id, document_version_id, page_number, width, height, rendered_image_key)
  SELECT
    (item ->> 'id')::uuid,
    v_version.workspace_id,
    v_version.id,
    (item ->> 'pageNumber')::integer,
    (item ->> 'width')::double precision,
    (item ->> 'height')::double precision,
    item ->> 'renderedImageKey'
  FROM jsonb_array_elements(p_payload -> 'pages') AS item;

  INSERT INTO blocks(
    id, workspace_id, document_version_id, page_id, parent_block_id, block_type, text, markdown, bbox,
    reading_order, confidence, heading_level, table_structure, formula_latex, image_object_key, source_hash
  )
  SELECT
    (item ->> 'id')::uuid,
    v_version.workspace_id,
    v_version.id,
    (item ->> 'pageId')::uuid,
    NULLIF(item ->> 'parentBlockId', '')::uuid,
    (item ->> 'blockType')::document_block_type,
    item ->> 'text',
    item ->> 'markdown',
    item -> 'bbox',
    (item ->> 'readingOrder')::integer,
    (item ->> 'confidence')::double precision,
    NULLIF(item ->> 'headingLevel', '')::smallint,
    item -> 'tableStructure',
    item ->> 'formulaLatex',
    item ->> 'imageObjectKey',
    item ->> 'sourceHash'
  FROM jsonb_array_elements(p_payload -> 'blocks') AS item;

  SELECT count(*)::integer INTO v_pages FROM pages WHERE document_version_id = v_version.id;
  SELECT count(*)::integer INTO v_blocks FROM blocks WHERE document_version_id = v_version.id;
  IF v_pages <> jsonb_array_length(p_payload -> 'pages')
    OR v_blocks <> jsonb_array_length(p_payload -> 'blocks') THEN
    RAISE EXCEPTION 'document_ir_index_conflict' USING ERRCODE = 'P0001';
  END IF;

  UPDATE document_versions
  SET ir_indexed_sha256 = p_ir_sha256, ir_indexed_at = p_indexed_at
  WHERE id = v_version.id;
  RETURN jsonb_build_object('page_count', v_pages, 'block_count', v_blocks, 'replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION index_document_ir_v1(uuid, integer, text, jsonb, timestamptz) FROM PUBLIC;
