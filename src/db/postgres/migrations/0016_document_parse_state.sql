ALTER TABLE document_versions
  ADD COLUMN parse_job_id uuid REFERENCES jobs(id),
  ADD COLUMN ir_object_key text,
  ADD COLUMN ir_sha256 char(64),
  ADD COLUMN parser text,
  ADD COLUMN parser_version text,
  ADD COLUMN page_count integer,
  ADD COLUMN parsed_at timestamptz,
  ADD CONSTRAINT document_versions_ir_object_tenant_prefix CHECK (
    ir_object_key IS NULL OR (
      ir_object_key LIKE 'tenant/' || workspace_id::text || '/%'
      AND ir_object_key !~ '(^|/)\.\.?(/|$)'
    )
  ),
  ADD CONSTRAINT document_versions_ir_sha256_format CHECK (
    ir_sha256 IS NULL OR ir_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT document_versions_parser_format CHECK (
    parser IS NULL OR parser ~ '^[a-z0-9][a-z0-9._-]{0,79}$'
  ),
  ADD CONSTRAINT document_versions_parser_version_safe CHECK (
    parser_version IS NULL OR (length(parser_version) BETWEEN 1 AND 80 AND parser_version ~ '^[ -~]+$')
  ),
  ADD CONSTRAINT document_versions_page_count_range CHECK (
    page_count IS NULL OR page_count BETWEEN 1 AND 10000
  ),
  ADD CONSTRAINT document_versions_parse_evidence_complete CHECK (
    num_nonnulls(ir_object_key, ir_sha256, parser, parser_version, page_count, parsed_at) IN (0, 6)
  );

CREATE INDEX document_versions_parse_job_idx
  ON document_versions(parse_job_id) WHERE parse_job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION start_document_parse_v1(p_job_id uuid, p_started_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_version document_versions%ROWTYPE;
  v_document documents%ROWTYPE;
  v_asset source_assets%ROWTYPE;
  v_result jsonb;
BEGIN
  IF p_started_at IS NULL OR p_started_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid_parse_timestamp' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.type <> 'document.parse' OR v_job.state <> 'running' THEN
    RAISE EXCEPTION 'parse_target_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT dv.* INTO v_version
  FROM document_versions dv
  JOIN documents d
    ON d.id = dv.document_id AND d.workspace_id = dv.workspace_id
  WHERE dv.id = v_job.resource_id
    AND dv.workspace_id = v_job.workspace_id
    AND d.current_version_id = dv.id
    AND d.deleted_at IS NULL
  FOR UPDATE OF dv;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_target_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_document FROM documents WHERE id = v_version.document_id FOR UPDATE;
  SELECT * INTO v_asset
  FROM source_assets
  WHERE workspace_id = v_version.workspace_id
    AND document_version_id = v_version.id
    AND kind = 'original'
    AND upload_state = 'uploaded'
  ORDER BY created_at, id
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parse_target_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_asset.scan_status <> 'clean' THEN
    RAISE EXCEPTION 'parse_target_not_clean' USING ERRCODE = 'P0001';
  END IF;

  IF v_version.status = 'scanned' THEN
    UPDATE document_versions
    SET status = 'parsing', parse_job_id = p_job_id, error_code = NULL
    WHERE id = v_version.id
    RETURNING * INTO v_version;
    UPDATE documents SET parse_status = 'parsing', updated_at = p_started_at
    WHERE id = v_document.id;
  ELSIF v_version.status = 'parsing' AND v_version.parse_job_id = p_job_id THEN
    NULL;
  ELSIF v_version.status = 'ready' AND v_version.parse_job_id = p_job_id THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'parse_state_conflict' USING ERRCODE = 'P0001';
  END IF;

  v_result := jsonb_build_object(
    'job_id', v_job.id,
    'workspace_id', v_version.workspace_id,
    'document_id', v_version.document_id,
    'document_version_id', v_version.id,
    'source_asset_id', v_asset.id,
    'source_object_key', v_asset.object_key,
    'source_sha256', v_asset.sha256,
    'size_bytes', v_asset.size_bytes,
    'mime_type', v_asset.mime_type,
    'parse_config', v_version.parse_config,
    'ir_schema_version', v_version.ir_schema_version,
    'parse_status', v_version.status
  );
  IF v_version.status = 'ready' THEN
    v_result := v_result || jsonb_build_object('result', jsonb_build_object(
      'ir_object_key', v_version.ir_object_key,
      'ir_sha256', v_version.ir_sha256,
      'parser', v_version.parser,
      'parser_version', v_version.parser_version,
      'page_count', v_version.page_count,
      'ir_schema_version', v_version.ir_schema_version
    ));
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION start_document_parse_v1(uuid, timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION record_document_parse_v1(
  p_job_id uuid,
  p_status text,
  p_ir_object_key text,
  p_ir_sha256 text,
  p_parser text,
  p_parser_version text,
  p_page_count integer,
  p_error_code text,
  p_completed_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_version document_versions%ROWTYPE;
  v_document_id uuid;
BEGIN
  IF p_status NOT IN ('ready', 'failed')
    OR p_completed_at IS NULL OR p_completed_at > now() + interval '5 minutes'
    OR (p_ir_sha256 IS NOT NULL AND p_ir_sha256 !~ '^[0-9a-f]{64}$')
    OR (p_parser IS NOT NULL AND p_parser !~ '^[a-z0-9][a-z0-9._-]{0,79}$')
    OR (p_parser_version IS NOT NULL AND
      (length(p_parser_version) NOT BETWEEN 1 AND 80 OR p_parser_version !~ '^[ -~]+$'))
    OR (p_page_count IS NOT NULL AND p_page_count NOT BETWEEN 1 AND 10000)
    OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z][a-z0-9_.-]{0,119}$') THEN
    RAISE EXCEPTION 'invalid_parse_result' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.type <> 'document.parse' OR v_job.state <> 'running' THEN
    RAISE EXCEPTION 'parse_target_not_found' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_version
  FROM document_versions
  WHERE id = v_job.resource_id AND workspace_id = v_job.workspace_id
  FOR UPDATE;
  IF NOT FOUND OR v_version.parse_job_id IS DISTINCT FROM p_job_id THEN
    RAISE EXCEPTION 'parse_target_not_found' USING ERRCODE = 'P0001';
  END IF;
  v_document_id := v_version.document_id;

  IF v_version.status IN ('ready', 'failed') THEN
    IF v_version.status::text IS DISTINCT FROM p_status
      OR (p_status = 'ready' AND (
        v_version.ir_object_key IS DISTINCT FROM p_ir_object_key
        OR v_version.ir_sha256 IS DISTINCT FROM p_ir_sha256
        OR v_version.parser IS DISTINCT FROM p_parser
        OR v_version.parser_version IS DISTINCT FROM p_parser_version
        OR v_version.page_count IS DISTINCT FROM p_page_count
        OR p_error_code IS NOT NULL
      ))
      OR (p_status = 'failed' AND (
        v_version.error_code IS DISTINCT FROM p_error_code
        OR num_nonnulls(p_ir_object_key, p_ir_sha256, p_parser, p_parser_version, p_page_count) <> 0
      )) THEN
      RAISE EXCEPTION 'parse_result_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object('status', v_version.status, 'replayed', true);
  END IF;

  IF v_version.status <> 'parsing' THEN
    RAISE EXCEPTION 'parse_state_conflict' USING ERRCODE = 'P0001';
  END IF;
  IF p_status = 'ready' THEN
    IF num_nonnulls(p_ir_object_key, p_ir_sha256, p_parser, p_parser_version, p_page_count) <> 5
      OR p_error_code IS NOT NULL
      OR p_ir_object_key ~ '(^|/)\.\.?(/|$)'
      OR p_ir_object_key NOT LIKE 'tenant/' || v_version.workspace_id::text || '/'
        || v_version.document_id::text || '/' || v_version.id::text || '/ir/%' THEN
      RAISE EXCEPTION 'invalid_parse_result' USING ERRCODE = 'P0001';
    END IF;
    UPDATE document_versions SET
      status = 'ready', error_code = NULL, ir_object_key = p_ir_object_key,
      ir_sha256 = p_ir_sha256, parser = p_parser, parser_version = p_parser_version,
      page_count = p_page_count, parsed_at = p_completed_at
    WHERE id = v_version.id;
    UPDATE documents SET parse_status = 'ready', updated_at = p_completed_at WHERE id = v_document_id;
  ELSE
    IF p_error_code IS NULL
      OR num_nonnulls(p_ir_object_key, p_ir_sha256, p_parser, p_parser_version, p_page_count) <> 0 THEN
      RAISE EXCEPTION 'invalid_parse_result' USING ERRCODE = 'P0001';
    END IF;
    UPDATE document_versions SET status = 'failed', error_code = p_error_code WHERE id = v_version.id;
    UPDATE documents SET parse_status = 'failed', updated_at = p_completed_at WHERE id = v_document_id;
  END IF;
  RETURN jsonb_build_object('status', p_status, 'replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION record_document_parse_v1(uuid, text, text, text, text, text, integer, text, timestamptz)
  FROM PUBLIC;
