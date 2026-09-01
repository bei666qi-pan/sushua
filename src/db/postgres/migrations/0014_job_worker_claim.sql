CREATE OR REPLACE FUNCTION claim_job_v1(
  p_job_id uuid,
  p_lease_seconds integer,
  p_event_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_status text;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'invalid_job_lease' USING ERRCODE = 'P0001';
  END IF;
  IF p_event_at IS NULL OR p_event_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid_job_event_time' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF p_event_at < v_job.updated_at THEN
    RAISE EXCEPTION 'stale_job_event' USING ERRCODE = 'P0001';
  END IF;

  IF v_job.state = 'cancel_requested' THEN
    UPDATE jobs
    SET state = 'cancelled', timeout_at = NULL, finished_at = p_event_at, updated_at = p_event_at
    WHERE id = p_job_id
    RETURNING * INTO v_job;
    v_status := 'ignored';
  ELSIF v_job.state IN ('succeeded', 'partially_succeeded', 'failed', 'dead_lettered', 'cancelled') THEN
    v_status := 'ignored';
  ELSIF v_job.state = 'queued' AND v_job.run_after > p_event_at THEN
    v_status := 'not_due';
  ELSIF v_job.state = 'running' AND v_job.timeout_at IS NOT NULL AND v_job.timeout_at > p_event_at THEN
    v_status := 'busy';
  ELSIF v_job.state IN ('queued', 'running') THEN
    IF v_job.attempt >= v_job.max_attempts THEN
      UPDATE jobs
      SET state = 'dead_lettered', timeout_at = NULL, error_code = 'job_lease_exhausted',
        finished_at = p_event_at, updated_at = p_event_at
      WHERE id = p_job_id
      RETURNING * INTO v_job;
      v_status := 'ignored';
    ELSE
      UPDATE jobs
      SET state = 'running', attempt = attempt + 1,
        started_at = COALESCE(started_at, p_event_at),
        timeout_at = p_event_at + make_interval(secs => p_lease_seconds),
        progress = jsonb_set(
          jsonb_set(progress, '{phase}', to_jsonb('running'::text), true),
          '{updatedAt}', to_jsonb(p_event_at), true
        ),
        error_code = NULL, updated_at = p_event_at
      WHERE id = p_job_id
      RETURNING * INTO v_job;
      v_status := 'claimed';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('status', v_status, 'job', to_jsonb(v_job));
END;
$$;

REVOKE ALL ON FUNCTION claim_job_v1(uuid, integer, timestamptz) FROM PUBLIC;
