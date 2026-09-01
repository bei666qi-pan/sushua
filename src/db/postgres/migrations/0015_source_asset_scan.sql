ALTER TABLE source_assets
  ADD COLUMN scan_job_id uuid REFERENCES jobs(id),
  ADD COLUMN scanned_sha256 char(64),
  ADD COLUMN scan_signature text,
  ADD COLUMN scan_error_code text,
  ADD COLUMN scanned_at timestamptz,
  ADD CONSTRAINT source_assets_scanned_sha256_format CHECK (
    scanned_sha256 IS NULL OR scanned_sha256 ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT source_assets_scan_signature_safe CHECK (
    scan_signature IS NULL OR (length(scan_signature) BETWEEN 1 AND 200 AND scan_signature ~ '^[ -~]+$')
  ),
  ADD CONSTRAINT source_assets_scan_error_code_format CHECK (
    scan_error_code IS NULL OR scan_error_code ~ '^[a-z][a-z0-9_.-]{0,119}$'
  ),
  ADD CONSTRAINT source_assets_scan_result_consistent CHECK (
    (scan_status = 'pending' AND scan_job_id IS NULL AND scanned_sha256 IS NULL
      AND scan_signature IS NULL AND scan_error_code IS NULL AND scanned_at IS NULL)
    OR
    (scan_status = 'clean' AND scan_job_id IS NOT NULL AND scanned_sha256 IS NOT NULL
      AND scan_signature IS NULL AND scan_error_code IS NULL AND scanned_at IS NOT NULL)
    OR
    (scan_status = 'infected' AND scan_job_id IS NOT NULL AND scanned_sha256 IS NOT NULL
      AND scan_signature IS NOT NULL AND scan_error_code = 'malware_detected' AND scanned_at IS NOT NULL)
    OR
    (scan_status = 'failed' AND scan_job_id IS NOT NULL
      AND scan_signature IS NULL AND scan_error_code IS NOT NULL AND scanned_at IS NOT NULL)
  );

CREATE INDEX source_assets_scan_job_idx ON source_assets(scan_job_id) WHERE scan_job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION read_source_asset_scan_target_v1(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result record;
BEGIN
  SELECT j.id AS job_id, j.workspace_id, sa.id AS asset_id, sa.object_key,
    sa.size_bytes, sa.sha256, sa.mime_type, sa.scan_status, sa.scan_error_code
  INTO v_result
  FROM jobs j
  JOIN source_assets sa
    ON sa.id = j.resource_id AND sa.workspace_id = j.workspace_id
  JOIN document_versions dv
    ON dv.id = sa.document_version_id AND dv.workspace_id = sa.workspace_id
  JOIN documents d
    ON d.id = dv.document_id AND d.workspace_id = sa.workspace_id
  WHERE j.id = p_job_id
    AND j.type = 'file.scan'
    AND j.state = 'running'
    AND sa.kind = 'original'
    AND sa.upload_state = 'uploaded'
    AND d.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scan_target_not_found' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object(
    'job_id', v_result.job_id,
    'workspace_id', v_result.workspace_id,
    'asset_id', v_result.asset_id,
    'object_key', v_result.object_key,
    'size_bytes', v_result.size_bytes,
    'sha256', v_result.sha256,
    'mime_type', v_result.mime_type,
    'scan_status', v_result.scan_status,
    'scan_error_code', v_result.scan_error_code
  );
END;
$$;

REVOKE ALL ON FUNCTION read_source_asset_scan_target_v1(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION record_source_asset_scan_v1(
  p_job_id uuid,
  p_status text,
  p_actual_sha256 text,
  p_signature text,
  p_error_code text,
  p_scanned_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_asset source_assets%ROWTYPE;
  v_document_id uuid;
BEGIN
  IF p_status NOT IN ('clean', 'infected', 'failed')
    OR p_scanned_at IS NULL OR p_scanned_at > now() + interval '5 minutes'
    OR (p_actual_sha256 IS NOT NULL AND p_actual_sha256 !~ '^[0-9a-f]{64}$')
    OR (p_signature IS NOT NULL AND (length(p_signature) NOT BETWEEN 1 AND 200 OR p_signature !~ '^[ -~]+$'))
    OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z][a-z0-9_.-]{0,119}$') THEN
    RAISE EXCEPTION 'invalid_scan_result' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.type <> 'file.scan' OR v_job.state <> 'running' THEN
    RAISE EXCEPTION 'scan_target_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT sa.* INTO v_asset
  FROM source_assets sa
  JOIN document_versions dv
    ON dv.id = sa.document_version_id AND dv.workspace_id = sa.workspace_id
  JOIN documents d
    ON d.id = dv.document_id AND d.workspace_id = sa.workspace_id
  WHERE sa.id = v_job.resource_id
    AND sa.workspace_id = v_job.workspace_id
    AND sa.kind = 'original'
    AND sa.upload_state = 'uploaded'
    AND d.deleted_at IS NULL
  FOR UPDATE OF sa;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scan_target_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT document_id INTO v_document_id
  FROM document_versions WHERE id = v_asset.document_version_id;

  IF v_asset.scan_status <> 'pending' THEN
    IF v_asset.scan_job_id IS DISTINCT FROM p_job_id
      OR v_asset.scan_status::text IS DISTINCT FROM p_status
      OR v_asset.scanned_sha256 IS DISTINCT FROM p_actual_sha256
      OR v_asset.scan_signature IS DISTINCT FROM p_signature
      OR (p_status = 'failed' AND v_asset.scan_error_code IS DISTINCT FROM p_error_code)
      OR (p_status = 'infected' AND v_asset.scan_error_code IS DISTINCT FROM 'malware_detected')
      OR (p_status = 'clean' AND v_asset.scan_error_code IS NOT NULL) THEN
      RAISE EXCEPTION 'scan_result_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object('status', v_asset.scan_status, 'replayed', true);
  END IF;

  IF p_status IN ('clean', 'infected') AND p_actual_sha256 IS DISTINCT FROM v_asset.sha256 THEN
    RAISE EXCEPTION 'scan_hash_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF (p_status = 'clean' AND (p_actual_sha256 IS NULL OR p_signature IS NOT NULL OR p_error_code IS NOT NULL))
    OR (p_status = 'infected' AND (p_actual_sha256 IS NULL OR p_signature IS NULL OR p_error_code IS NOT NULL))
    OR (p_status = 'failed' AND (p_signature IS NOT NULL OR p_error_code IS NULL)) THEN
    RAISE EXCEPTION 'invalid_scan_result' USING ERRCODE = 'P0001';
  END IF;

  UPDATE source_assets SET
    scan_status = p_status::source_asset_scan_status,
    scan_job_id = p_job_id,
    scanned_sha256 = p_actual_sha256,
    scan_signature = p_signature,
    scan_error_code = CASE WHEN p_status = 'infected' THEN 'malware_detected' ELSE p_error_code END,
    scanned_at = p_scanned_at
  WHERE id = v_asset.id;

  IF p_status = 'clean' THEN
    UPDATE document_versions SET status = 'scanned', error_code = NULL WHERE id = v_asset.document_version_id;
  ELSE
    UPDATE document_versions
    SET status = 'failed', error_code = CASE WHEN p_status = 'infected' THEN 'malware_detected' ELSE p_error_code END
    WHERE id = v_asset.document_version_id;
    UPDATE documents SET parse_status = 'failed', updated_at = p_scanned_at WHERE id = v_document_id;
  END IF;

  RETURN jsonb_build_object('status', p_status, 'replayed', false);
END;
$$;

REVOKE ALL ON FUNCTION record_source_asset_scan_v1(uuid, text, text, text, text, timestamptz) FROM PUBLIC;
