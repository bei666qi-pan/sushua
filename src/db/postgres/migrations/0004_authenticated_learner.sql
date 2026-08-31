CREATE OR REPLACE FUNCTION resolve_authenticated_learner(p_candidate_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := app_current_user_id();
  v_learner_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'missing_authenticated_user_context' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM users WHERE id = v_user_id) THEN
    RAISE EXCEPTION 'authenticated_user_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_learner_id
  FROM learners
  WHERE user_id = v_user_id
  LIMIT 1;

  IF v_learner_id IS NOT NULL THEN
    RETURN v_learner_id;
  END IF;

  INSERT INTO learners (id, user_id)
  VALUES (p_candidate_id, v_user_id)
  ON CONFLICT (user_id) WHERE user_id IS NOT NULL DO NOTHING;

  SELECT id INTO v_learner_id
  FROM learners
  WHERE user_id = v_user_id
  LIMIT 1;

  IF v_learner_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_learner_resolution_failed' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_learner_id;
END;
$$;

REVOKE ALL ON FUNCTION resolve_authenticated_learner(uuid) FROM PUBLIC;
