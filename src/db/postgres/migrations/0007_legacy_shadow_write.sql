CREATE OR REPLACE FUNCTION shadow_sync_legacy_workspace(
  p_legacy_bank_id text,
  p_legacy_slug text,
  p_title text,
  p_visibility text,
  p_owner_key_hash text,
  p_checksum text,
  p_created_at timestamptz,
  p_candidate_learner_id uuid,
  p_candidate_workspace_id uuid
)
RETURNS TABLE(status text, result_workspace_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mapping legacy_bank_mappings%ROWTYPE;
  v_workspace workspaces%ROWTYPE;
  v_conflicts integer;
BEGIN
  IF p_legacy_bank_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'invalid_legacy_bank_id' USING ERRCODE = 'P0001';
  END IF;
  IF p_legacy_slug !~ '^[a-z0-9][a-z0-9-]{2,62}$' THEN
    RAISE EXCEPTION 'invalid_legacy_slug' USING ERRCODE = 'P0001';
  END IF;
  IF length(p_title) < 1 OR length(p_title) > 80 THEN
    RAISE EXCEPTION 'invalid_legacy_title' USING ERRCODE = 'P0001';
  END IF;
  IF p_visibility NOT IN ('private', 'link', 'public') THEN
    RAISE EXCEPTION 'invalid_legacy_visibility' USING ERRCODE = 'P0001';
  END IF;
  IF p_owner_key_hash !~ '^[0-9a-f]{64}$' OR p_checksum !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_legacy_hash' USING ERRCODE = 'P0001';
  END IF;

  SELECT COUNT(*)::int INTO v_conflicts
  FROM legacy_bank_mappings
  WHERE legacy_bank_id = p_legacy_bank_id OR legacy_slug = p_legacy_slug;

  SELECT * INTO v_mapping
  FROM legacy_bank_mappings
  WHERE legacy_bank_id = p_legacy_bank_id AND legacy_slug = p_legacy_slug
  FOR UPDATE;

  IF v_conflicts > 0 AND NOT FOUND THEN
    RAISE EXCEPTION 'legacy_shadow_mapping_identity_conflict' USING ERRCODE = 'P0001';
  END IF;

  IF FOUND THEN
    IF v_mapping.owner_key_hash <> p_owner_key_hash THEN
      RAISE EXCEPTION 'legacy_shadow_owner_mismatch' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_workspace FROM workspaces WHERE id = v_mapping.workspace_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'legacy_shadow_workspace_missing' USING ERRCODE = 'P0001';
    END IF;
    IF v_mapping.checksum = p_checksum
       AND v_workspace.title = p_title
       AND v_workspace.visibility::text = p_visibility
       AND v_workspace.deleted_at IS NULL THEN
      RETURN QUERY SELECT 'replayed'::text, v_mapping.workspace_id;
      RETURN;
    END IF;
    UPDATE workspaces
    SET title = p_title, visibility = p_visibility::workspace_visibility, deleted_at = NULL, updated_at = now()
    WHERE id = v_mapping.workspace_id;
    UPDATE legacy_bank_mappings SET checksum = p_checksum WHERE workspace_id = v_mapping.workspace_id;
    RETURN QUERY SELECT 'updated'::text, v_mapping.workspace_id;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM workspaces WHERE slug = p_legacy_slug) THEN
    RAISE EXCEPTION 'legacy_shadow_workspace_slug_taken' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO learners (id) VALUES (p_candidate_learner_id);
  INSERT INTO workspaces (
    id, slug, title, visibility, created_by_learner_id, detected_mode, created_at, updated_at
  ) VALUES (
    p_candidate_workspace_id, p_legacy_slug, p_title, p_visibility::workspace_visibility,
    p_candidate_learner_id, 'question_bank', p_created_at, p_created_at
  );
  INSERT INTO workspace_members (workspace_id, learner_id, role, created_at)
  VALUES (p_candidate_workspace_id, p_candidate_learner_id, 'owner', p_created_at);
  INSERT INTO legacy_bank_mappings (
    legacy_bank_id, legacy_slug, workspace_id, owner_key_hash, checksum
  ) VALUES (
    p_legacy_bank_id, p_legacy_slug, p_candidate_workspace_id, p_owner_key_hash, p_checksum
  );
  RETURN QUERY SELECT 'created'::text, p_candidate_workspace_id;
END;
$$;

REVOKE ALL ON FUNCTION shadow_sync_legacy_workspace(text, text, text, text, text, text, timestamptz, uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION shadow_delete_legacy_workspace(p_legacy_slug text, p_owner_key_hash text)
RETURNS TABLE(status text, result_workspace_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_mapping legacy_bank_mappings%ROWTYPE;
  v_creator_id uuid;
BEGIN
  SELECT * INTO v_mapping
  FROM legacy_bank_mappings
  WHERE legacy_slug = p_legacy_slug
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'missing'::text, NULL::uuid;
    RETURN;
  END IF;
  IF v_mapping.owner_key_hash <> p_owner_key_hash THEN
    RAISE EXCEPTION 'legacy_shadow_owner_mismatch' USING ERRCODE = 'P0001';
  END IF;
  SELECT created_by_learner_id INTO v_creator_id FROM workspaces WHERE id = v_mapping.workspace_id FOR UPDATE;
  DELETE FROM workspaces WHERE id = v_mapping.workspace_id;
  DELETE FROM learners l
  WHERE l.id = v_creator_id
    AND l.user_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM guest_sessions gs WHERE gs.learner_id = l.id)
    AND NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.learner_id = l.id)
    AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.created_by_learner_id = l.id);
  RETURN QUERY SELECT 'deleted'::text, v_mapping.workspace_id;
END;
$$;

REVOKE ALL ON FUNCTION shadow_delete_legacy_workspace(text, text) FROM PUBLIC;
