ALTER TABLE source_assets
  ADD COLUMN completion_idempotency_key text,
  ADD COLUMN completion_request_hash char(64),
  ADD CONSTRAINT source_assets_completion_idempotency_length CHECK (
    completion_idempotency_key IS NULL OR length(completion_idempotency_key) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT source_assets_completion_request_hash_format CHECK (
    completion_request_hash IS NULL OR completion_request_hash ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT source_assets_upload_completion_consistent CHECK (
    (upload_state IS NULL AND upload_completed_at IS NULL
      AND completion_idempotency_key IS NULL AND completion_request_hash IS NULL)
    OR
    (upload_state = 'initiated' AND upload_completed_at IS NULL
      AND completion_idempotency_key IS NULL AND completion_request_hash IS NULL)
    OR
    (upload_state = 'uploaded' AND upload_completed_at IS NOT NULL
      AND completion_idempotency_key IS NOT NULL AND completion_request_hash IS NOT NULL)
    OR
    (upload_state = 'aborted' AND upload_completed_at IS NULL
      AND completion_idempotency_key IS NULL AND completion_request_hash IS NULL)
  );

CREATE OR REPLACE FUNCTION complete_source_upload_v1(
  p_asset_id uuid,
  p_workspace_id uuid,
  p_learner_id uuid,
  p_storage_upload_id text,
  p_size_bytes bigint,
  p_sha256 text,
  p_mime_type text,
  p_completion_idempotency_key text,
  p_completion_request_hash text,
  p_job_request_hash text,
  p_candidate_job_id uuid,
  p_trace_id uuid,
  p_completed_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_asset source_assets%ROWTYPE;
  v_document_id uuid;
  v_job jobs%ROWTYPE;
  v_submitted jsonb;
BEGIN
  IF app_current_learner_id() IS DISTINCT FROM p_learner_id
    OR app_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'upload_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF p_storage_upload_id IS NULL OR length(p_storage_upload_id) NOT BETWEEN 1 AND 1024
    OR p_size_bytes < 1 OR p_size_bytes > 209715200
    OR p_sha256 !~ '^[0-9a-f]{64}$'
    OR p_mime_type !~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$'
    OR p_completion_idempotency_key IS NULL
    OR length(p_completion_idempotency_key) NOT BETWEEN 1 AND 200
    OR btrim(p_completion_idempotency_key) <> p_completion_idempotency_key
    OR p_completion_request_hash !~ '^[0-9a-f]{64}$'
    OR p_job_request_hash !~ '^[0-9a-f]{64}$'
    OR p_completed_at IS NULL THEN
    RAISE EXCEPTION 'invalid_upload_completion' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':upload-complete:' || p_asset_id::text, 0));
  SELECT sa.* INTO v_asset
  FROM source_assets sa
  JOIN document_versions dv
    ON dv.id = sa.document_version_id AND dv.workspace_id = sa.workspace_id
  JOIN documents d
    ON d.id = dv.document_id AND d.workspace_id = sa.workspace_id
  JOIN workspace_members wm
    ON wm.workspace_id = sa.workspace_id
      AND wm.learner_id = p_learner_id
      AND wm.role IN ('owner', 'editor')
  WHERE sa.id = p_asset_id
    AND sa.workspace_id = p_workspace_id
    AND sa.kind = 'original'
    AND d.deleted_at IS NULL
  FOR UPDATE OF sa, dv, d;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload_not_found' USING ERRCODE = 'P0001';
  END IF;
  SELECT document_id INTO v_document_id
  FROM document_versions
  WHERE id = v_asset.document_version_id;

  IF v_asset.upload_state = 'uploaded' THEN
    IF v_asset.storage_upload_id IS DISTINCT FROM p_storage_upload_id
      OR v_asset.size_bytes IS DISTINCT FROM p_size_bytes
      OR v_asset.sha256 IS DISTINCT FROM p_sha256
      OR v_asset.mime_type IS DISTINCT FROM p_mime_type
      OR v_asset.completion_idempotency_key IS DISTINCT FROM p_completion_idempotency_key
      OR v_asset.completion_request_hash IS DISTINCT FROM p_completion_request_hash THEN
      RAISE EXCEPTION 'upload_completion_idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_job FROM jobs
    WHERE workspace_id = p_workspace_id
      AND resource_id = p_asset_id
      AND type = 'file.scan'
      AND idempotency_key = 'file.scan:' || p_asset_id::text;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'upload_completion_job_missing' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object('status', 'replayed', 'job', to_jsonb(v_job));
  END IF;

  IF v_asset.upload_state IS DISTINCT FROM 'initiated'
    OR v_asset.storage_upload_id IS DISTINCT FROM p_storage_upload_id
    OR v_asset.size_bytes IS DISTINCT FROM p_size_bytes
    OR v_asset.sha256 IS DISTINCT FROM p_sha256
    OR v_asset.mime_type IS DISTINCT FROM p_mime_type THEN
    RAISE EXCEPTION 'upload_metadata_mismatch' USING ERRCODE = 'P0001';
  END IF;

  UPDATE source_assets
  SET upload_state = 'uploaded', upload_completed_at = p_completed_at,
    completion_idempotency_key = p_completion_idempotency_key,
    completion_request_hash = p_completion_request_hash
  WHERE id = p_asset_id;
  UPDATE document_versions SET status = 'scan_pending' WHERE id = v_asset.document_version_id;
  UPDATE documents SET parse_status = 'scan_pending', updated_at = p_completed_at WHERE id = v_document_id;

  v_submitted := submit_job_v1(
    p_candidate_job_id,
    p_asset_id,
    'file.scan',
    p_workspace_id,
    'file.scan:' || p_asset_id::text,
    p_job_request_hash,
    0,
    '{}'::jsonb,
    2,
    p_trace_id,
    p_learner_id,
    p_completed_at
  );
  RETURN jsonb_build_object('status', 'created', 'job', v_submitted->'job');
END;
$$;

REVOKE ALL ON FUNCTION complete_source_upload_v1(
  uuid, uuid, uuid, text, bigint, text, text, text, text, text, uuid, uuid, timestamptz
) FROM PUBLIC;
