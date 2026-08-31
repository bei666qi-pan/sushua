CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

DROP POLICY learners_self_update ON learners;
CREATE POLICY learners_self_update ON learners FOR UPDATE
  USING (id = app_current_learner_id())
  WITH CHECK (
    id = app_current_learner_id()
    AND (user_id IS NULL OR user_id = app_current_user_id())
  );

CREATE OR REPLACE FUNCTION claim_guest_learner(p_token_hash text)
RETURNS TABLE(status text, learner_id uuid, existing_learner_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_learner_id uuid := app_current_learner_id();
  v_user_id uuid := app_current_user_id();
  v_learner learners%ROWTYPE;
  v_guest guest_sessions%ROWTYPE;
  v_existing_learner_id uuid;
BEGIN
  IF v_learner_id IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'missing_claim_context' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_learner FROM learners WHERE id = v_learner_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'learner_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_guest
  FROM guest_sessions
  WHERE guest_sessions.learner_id = v_learner_id
    AND token_hash = p_token_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_guest_proof' USING ERRCODE = 'P0001';
  END IF;

  IF v_learner.user_id = v_user_id
    AND v_guest.claimed_by_user_id = v_user_id
    AND v_guest.claimed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already_claimed'::text, v_learner_id, NULL::uuid;
    RETURN;
  END IF;

  IF v_guest.expires_at <= now() THEN
    RAISE EXCEPTION 'guest_session_expired' USING ERRCODE = 'P0001';
  END IF;
  IF v_learner.user_id IS NOT NULL OR v_guest.claimed_at IS NOT NULL THEN
    RAISE EXCEPTION 'guest_already_claimed_by_another_user' USING ERRCODE = 'P0001';
  END IF;

  SELECT id INTO v_existing_learner_id
  FROM learners
  WHERE user_id = v_user_id AND id <> v_learner_id
  LIMIT 1;
  IF v_existing_learner_id IS NOT NULL THEN
    RETURN QUERY SELECT 'conflict'::text, v_learner_id, v_existing_learner_id;
    RETURN;
  END IF;

  UPDATE learners SET user_id = v_user_id WHERE id = v_learner_id;
  UPDATE guest_sessions
  SET claimed_at = now(), claimed_by_user_id = v_user_id, last_seen_at = now()
  WHERE id = v_guest.id;

  RETURN QUERY SELECT 'claimed'::text, v_learner_id, NULL::uuid;
END;
$$;

REVOKE ALL ON FUNCTION claim_guest_learner(text) FROM PUBLIC;
