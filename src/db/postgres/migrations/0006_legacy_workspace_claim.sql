ALTER TABLE legacy_bank_mappings
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN claimed_by_learner_id uuid REFERENCES learners(id) ON DELETE SET NULL,
  ADD CONSTRAINT legacy_bank_mappings_claim_pair CHECK (
    (claimed_at IS NULL AND claimed_by_learner_id IS NULL)
    OR (claimed_at IS NOT NULL AND claimed_by_learner_id IS NOT NULL)
  );

CREATE INDEX legacy_bank_mappings_claimed_by_idx
  ON legacy_bank_mappings(claimed_by_learner_id)
  WHERE claimed_by_learner_id IS NOT NULL;

CREATE OR REPLACE FUNCTION claim_legacy_workspace(p_owner_key_hash text)
RETURNS TABLE(status text, learner_id uuid, workspace_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_learner_id uuid := app_current_learner_id();
  v_user_id uuid := app_current_user_id();
  v_workspace_id uuid := app_current_workspace_id();
  v_mapping legacy_bank_mappings%ROWTYPE;
BEGIN
  IF v_learner_id IS NULL OR v_user_id IS NULL OR v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'missing_legacy_claim_context' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM learners WHERE id = v_learner_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'authenticated_learner_mismatch' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_mapping
  FROM legacy_bank_mappings
  WHERE legacy_bank_mappings.workspace_id = v_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'legacy_mapping_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_mapping.owner_key_hash <> p_owner_key_hash THEN
    RAISE EXCEPTION 'invalid_legacy_owner_key' USING ERRCODE = 'P0001';
  END IF;
  IF v_mapping.claimed_by_learner_id = v_learner_id THEN
    RETURN QUERY SELECT 'already_claimed'::text, v_learner_id, v_workspace_id;
    RETURN;
  END IF;
  IF v_mapping.claimed_by_learner_id IS NOT NULL THEN
    RAISE EXCEPTION 'legacy_workspace_already_claimed' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1 FROM workspaces WHERE id = v_workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'legacy_workspace_not_found' USING ERRCODE = 'P0001';
  END IF;

  UPDATE workspaces
  SET created_by_learner_id = v_learner_id, updated_at = now()
  WHERE id = v_workspace_id;
  DELETE FROM workspace_members WHERE workspace_members.workspace_id = v_workspace_id AND role = 'owner';
  INSERT INTO workspace_members (workspace_id, learner_id, role)
  VALUES (v_workspace_id, v_learner_id, 'owner')
  ON CONFLICT ON CONSTRAINT workspace_members_pkey DO UPDATE SET role = 'owner';
  UPDATE legacy_bank_mappings
  SET claimed_at = now(), claimed_by_learner_id = v_learner_id
  WHERE legacy_bank_mappings.workspace_id = v_workspace_id;

  RETURN QUERY SELECT 'claimed'::text, v_learner_id, v_workspace_id;
END;
$$;

REVOKE ALL ON FUNCTION claim_legacy_workspace(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION claim_legacy_workspace_by_slug(p_legacy_slug text, p_owner_key_hash text)
RETURNS TABLE(status text, learner_id uuid, workspace_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_learner_id uuid := app_current_learner_id();
  v_user_id uuid := app_current_user_id();
  v_workspace_id uuid;
  v_mapping legacy_bank_mappings%ROWTYPE;
BEGIN
  IF v_learner_id IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'missing_legacy_claim_context' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM learners WHERE id = v_learner_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'authenticated_learner_mismatch' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_mapping
  FROM legacy_bank_mappings
  WHERE legacy_slug = p_legacy_slug
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'legacy_mapping_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_mapping.owner_key_hash <> p_owner_key_hash THEN
    RAISE EXCEPTION 'invalid_legacy_owner_key' USING ERRCODE = 'P0001';
  END IF;

  v_workspace_id := v_mapping.workspace_id;
  IF v_mapping.claimed_by_learner_id = v_learner_id THEN
    RETURN QUERY SELECT 'already_claimed'::text, v_learner_id, v_workspace_id;
    RETURN;
  END IF;
  IF v_mapping.claimed_by_learner_id IS NOT NULL THEN
    RAISE EXCEPTION 'legacy_workspace_already_claimed' USING ERRCODE = 'P0001';
  END IF;

  PERFORM 1 FROM workspaces WHERE id = v_workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'legacy_workspace_not_found' USING ERRCODE = 'P0001';
  END IF;

  UPDATE workspaces
  SET created_by_learner_id = v_learner_id, updated_at = now()
  WHERE id = v_workspace_id;
  DELETE FROM workspace_members WHERE workspace_members.workspace_id = v_workspace_id AND role = 'owner';
  INSERT INTO workspace_members (workspace_id, learner_id, role)
  VALUES (v_workspace_id, v_learner_id, 'owner')
  ON CONFLICT ON CONSTRAINT workspace_members_pkey DO UPDATE SET role = 'owner';
  UPDATE legacy_bank_mappings
  SET claimed_at = now(), claimed_by_learner_id = v_learner_id
  WHERE legacy_bank_mappings.workspace_id = v_workspace_id;

  RETURN QUERY SELECT 'claimed'::text, v_learner_id, v_workspace_id;
END;
$$;

REVOKE ALL ON FUNCTION claim_legacy_workspace_by_slug(text, text) FROM PUBLIC;
