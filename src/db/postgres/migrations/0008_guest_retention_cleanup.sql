CREATE OR REPLACE FUNCTION purge_expired_guest_learners(
  p_before timestamptz,
  p_limit integer
)
RETURNS TABLE(purged_sessions integer, purged_learners integer, purged_workspaces integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_learner_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_before IS NULL OR p_before > now() THEN
    RAISE EXCEPTION 'invalid_guest_cleanup_cutoff' USING ERRCODE = 'P0001';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_guest_cleanup_limit' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(candidate.learner_id ORDER BY candidate.expires_at, candidate.session_id), ARRAY[]::uuid[])
  INTO v_learner_ids
  FROM (
    SELECT gs.learner_id, gs.expires_at, gs.id AS session_id
    FROM guest_sessions gs
    JOIN learners l ON l.id = gs.learner_id
    WHERE gs.expires_at <= p_before
      AND gs.claimed_at IS NULL
      AND gs.claimed_by_user_id IS NULL
      AND l.user_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM workspace_members wm
        JOIN workspaces w ON w.id = wm.workspace_id
        WHERE wm.learner_id = l.id
          AND wm.role = 'owner'
          AND w.created_by_learner_id <> l.id
      )
    ORDER BY gs.expires_at, gs.id
    FOR UPDATE OF gs, l SKIP LOCKED
    LIMIT p_limit
  ) AS candidate;

  purged_sessions := cardinality(v_learner_ids);
  IF purged_sessions = 0 THEN
    purged_learners := 0;
    purged_workspaces := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COUNT(*)::integer INTO purged_workspaces
  FROM workspaces
  WHERE created_by_learner_id = ANY(v_learner_ids);

  DELETE FROM workspaces
  WHERE created_by_learner_id = ANY(v_learner_ids);

  DELETE FROM learners l
  WHERE l.id = ANY(v_learner_ids)
    AND l.user_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM guest_sessions gs
      WHERE gs.learner_id = l.id
        AND gs.expires_at <= p_before
        AND gs.claimed_at IS NULL
        AND gs.claimed_by_user_id IS NULL
    );
  GET DIAGNOSTICS purged_learners = ROW_COUNT;

  IF purged_learners <> purged_sessions THEN
    RAISE EXCEPTION 'guest_cleanup_concurrent_state_changed' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION purge_expired_guest_learners(timestamptz, integer) FROM PUBLIC;
