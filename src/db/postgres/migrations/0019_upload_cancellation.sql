CREATE OR REPLACE FUNCTION abort_source_upload_v1(
  p_asset_id uuid,
  p_learner_id uuid,
  p_cancelled_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_asset source_assets%ROWTYPE;
  v_document_id uuid;
  v_status text;
BEGIN
  IF app_current_learner_id() IS DISTINCT FROM p_learner_id OR p_cancelled_at IS NULL THEN
    RAISE EXCEPTION 'upload_not_found' USING ERRCODE = 'P0001';
  END IF;

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
  WHERE sa.id = p_asset_id AND sa.kind = 'original'
  FOR UPDATE OF sa;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'upload_not_found' USING ERRCODE = 'P0001';
  END IF;
  SELECT document_id INTO v_document_id
  FROM document_versions
  WHERE id = v_asset.document_version_id;

  IF v_asset.upload_state = 'uploaded' THEN
    RAISE EXCEPTION 'upload_not_cancellable' USING ERRCODE = 'P0001';
  ELSIF v_asset.upload_state = 'aborted' THEN
    v_status := 'replayed';
  ELSIF v_asset.upload_state = 'initiated' THEN
    UPDATE source_assets SET upload_state = 'aborted' WHERE id = p_asset_id;
    UPDATE document_versions
      SET status = 'failed', error_code = 'upload_cancelled'
      WHERE id = v_asset.document_version_id;
    UPDATE documents
      SET parse_status = 'failed', deleted_at = COALESCE(deleted_at, p_cancelled_at), updated_at = p_cancelled_at
      WHERE id = v_document_id;
    v_status := 'created';
  ELSE
    RAISE EXCEPTION 'upload_not_cancellable' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'workspace_id', v_asset.workspace_id,
    'object_key', v_asset.object_key,
    'storage_upload_id', v_asset.storage_upload_id
  );
END;
$$;

REVOKE ALL ON FUNCTION abort_source_upload_v1(uuid, uuid, timestamptz) FROM PUBLIC;
