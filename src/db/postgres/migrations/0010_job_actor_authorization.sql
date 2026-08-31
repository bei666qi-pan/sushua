CREATE OR REPLACE FUNCTION request_job_cancel(p_job_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job jobs%ROWTYPE;
BEGIN
  SELECT j.* INTO v_job
  FROM jobs j
  JOIN workspace_members wm ON wm.workspace_id = j.workspace_id
  WHERE j.id = p_job_id
    AND wm.learner_id = app_current_learner_id()
    AND wm.role IN ('owner', 'editor')
  FOR UPDATE OF j;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_job.state IN ('cancel_requested', 'cancelled') THEN
    RETURN to_jsonb(v_job);
  END IF;
  IF v_job.state NOT IN ('queued', 'running') THEN
    RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001';
  END IF;
  UPDATE jobs
  SET state = 'cancel_requested', cancel_reason = left(NULLIF(p_reason, ''), 120), updated_at = now()
  WHERE id = p_job_id
  RETURNING * INTO v_job;
  RETURN to_jsonb(v_job);
END;
$$;
REVOKE ALL ON FUNCTION request_job_cancel(uuid, text) FROM PUBLIC;
