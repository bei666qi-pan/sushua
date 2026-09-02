CREATE OR REPLACE FUNCTION claim_job_v2(p_job_id uuid, p_lease_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_status text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'invalid_job_lease' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job_not_found' USING ERRCODE = 'P0001';
  END IF;

  IF v_job.state = 'cancel_requested' THEN
    UPDATE jobs SET state = 'cancelled', timeout_at = NULL,
      finished_at = v_now, updated_at = v_now
    WHERE id = p_job_id RETURNING * INTO v_job;
    v_status := 'ignored';
  ELSIF v_job.state IN ('succeeded', 'partially_succeeded', 'failed', 'dead_lettered', 'cancelled') THEN
    v_status := 'ignored';
  ELSIF v_job.state = 'queued' AND v_job.run_after > v_now THEN
    v_status := 'not_due';
  ELSIF v_job.state = 'running' AND v_job.timeout_at IS NOT NULL AND v_job.timeout_at > v_now THEN
    v_status := 'busy';
  ELSIF v_job.state IN ('queued', 'running') THEN
    IF v_job.attempt >= v_job.max_attempts THEN
      UPDATE jobs SET state = 'dead_lettered', timeout_at = NULL,
        error_code = 'job_lease_exhausted', finished_at = v_now, updated_at = v_now
      WHERE id = p_job_id RETURNING * INTO v_job;
      v_status := 'ignored';
    ELSE
      UPDATE jobs SET state = 'running', attempt = attempt + 1,
        started_at = COALESCE(started_at, v_now),
        timeout_at = v_now + make_interval(secs => p_lease_seconds),
        progress = jsonb_set(
          jsonb_set(progress, '{phase}', to_jsonb('running'::text), true),
          '{updatedAt}', to_jsonb(v_now), true
        ),
        error_code = NULL, updated_at = v_now
      WHERE id = p_job_id RETURNING * INTO v_job;
      v_status := 'claimed';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('status', v_status, 'job', to_jsonb(v_job));
END;
$$;

REVOKE ALL ON FUNCTION claim_job_v2(uuid, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION heartbeat_job_v1(
  p_job_id uuid,
  p_expected_attempt integer,
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_status text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_expected_attempt IS NULL OR p_expected_attempt < 1
    OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'invalid_job_heartbeat' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_not_found' USING ERRCODE = 'P0001'; END IF;

  IF v_job.attempt <> p_expected_attempt THEN
    v_status := 'lease_lost';
  ELSIF v_job.state = 'cancel_requested' THEN
    v_status := 'cancel_requested';
  ELSIF v_job.state <> 'running' OR v_job.timeout_at IS NULL OR v_job.timeout_at <= v_now THEN
    v_status := 'lease_lost';
  ELSE
    UPDATE jobs SET timeout_at = v_now + make_interval(secs => p_lease_seconds),
      updated_at = v_now
    WHERE id = p_job_id RETURNING * INTO v_job;
    v_status := 'active';
  END IF;
  RETURN jsonb_build_object('status', v_status, 'job', to_jsonb(v_job));
END;
$$;

REVOKE ALL ON FUNCTION heartbeat_job_v1(uuid, integer, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION transition_job_v2(
  p_job_id uuid,
  p_expected_attempt integer,
  p_event text,
  p_progress jsonb,
  p_checkpoint jsonb,
  p_error_code text,
  p_run_after timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job jobs%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_progress jsonb;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job_not_found' USING ERRCODE = 'P0001'; END IF;
  IF p_expected_attempt IS NULL OR v_job.attempt <> p_expected_attempt THEN
    RAISE EXCEPTION 'stale_job_attempt' USING ERRCODE = 'P0001';
  END IF;
  IF v_job.state = 'cancel_requested' THEN
    UPDATE jobs SET state = 'cancelled', timeout_at = NULL,
      finished_at = v_now, updated_at = v_now
    WHERE id = p_job_id RETURNING * INTO v_job;
    RETURN to_jsonb(v_job);
  END IF;
  IF v_job.state = 'running' AND (v_job.timeout_at IS NULL OR v_job.timeout_at <= v_now) THEN
    RAISE EXCEPTION 'job_lease_expired' USING ERRCODE = 'P0001';
  END IF;

  CASE p_event
    WHEN 'progress' THEN
      IF v_job.state <> 'running' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      IF p_progress IS NULL OR jsonb_typeof(p_progress) <> 'object'
        OR octet_length(p_progress::text) > 4096
        OR p_progress - ARRAY['phase', 'percent', 'current', 'total', 'messageCode', 'updatedAt'] <> '{}'::jsonb
        OR NOT p_progress ? 'phase' OR NOT p_progress ? 'percent'
        OR jsonb_typeof(p_progress->'phase') <> 'string'
        OR jsonb_typeof(p_progress->'percent') <> 'number'
        OR (p_progress->>'percent')::numeric NOT BETWEEN 0 AND 100 THEN
        RAISE EXCEPTION 'invalid_job_progress' USING ERRCODE = 'P0001';
      END IF;
      IF p_progress ? 'current' AND (jsonb_typeof(p_progress->'current') <> 'number'
        OR (p_progress->>'current')::numeric < 0
        OR (p_progress->>'current')::numeric <> trunc((p_progress->>'current')::numeric)) THEN
        RAISE EXCEPTION 'invalid_job_progress' USING ERRCODE = 'P0001';
      END IF;
      IF p_progress ? 'total' AND (jsonb_typeof(p_progress->'total') <> 'number'
        OR (p_progress->>'total')::numeric < 0
        OR (p_progress->>'total')::numeric <> trunc((p_progress->>'total')::numeric)) THEN
        RAISE EXCEPTION 'invalid_job_progress' USING ERRCODE = 'P0001';
      END IF;
      IF p_progress ? 'messageCode' AND jsonb_typeof(p_progress->'messageCode') <> 'string' THEN
        RAISE EXCEPTION 'invalid_job_progress' USING ERRCODE = 'P0001';
      END IF;
      v_progress := jsonb_set(p_progress, '{updatedAt}', to_jsonb(v_now), true);
      UPDATE jobs SET progress = v_progress,
        checkpoint = COALESCE(p_checkpoint, checkpoint), updated_at = v_now
      WHERE id = p_job_id RETURNING * INTO v_job;
    WHEN 'retry' THEN
      IF v_job.state <> 'running' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      IF v_job.attempt >= v_job.max_attempts THEN RAISE EXCEPTION 'job_attempts_exhausted' USING ERRCODE = 'P0001'; END IF;
      UPDATE jobs SET state = 'queued', timeout_at = NULL,
        error_code = left(NULLIF(p_error_code, ''), 120),
        run_after = COALESCE(p_run_after, v_now), updated_at = v_now
      WHERE id = p_job_id RETURNING * INTO v_job;
    WHEN 'succeed' THEN
      IF v_job.state <> 'running' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      UPDATE jobs SET state = 'succeeded', timeout_at = NULL,
        checkpoint = COALESCE(p_checkpoint, checkpoint), finished_at = v_now, updated_at = v_now
      WHERE id = p_job_id RETURNING * INTO v_job;
    WHEN 'partial_succeed' THEN
      IF v_job.state <> 'running' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      UPDATE jobs SET state = 'partially_succeeded', timeout_at = NULL,
        checkpoint = COALESCE(p_checkpoint, checkpoint),
        error_code = left(NULLIF(p_error_code, ''), 120), finished_at = v_now, updated_at = v_now
      WHERE id = p_job_id RETURNING * INTO v_job;
    WHEN 'fail' THEN
      IF v_job.state <> 'running' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      UPDATE jobs SET state = 'failed', timeout_at = NULL,
        error_code = left(NULLIF(p_error_code, ''), 120), finished_at = v_now, updated_at = v_now
      WHERE id = p_job_id RETURNING * INTO v_job;
    WHEN 'dead_letter' THEN
      IF v_job.state <> 'running' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      UPDATE jobs SET state = 'dead_lettered', timeout_at = NULL,
        error_code = left(NULLIF(p_error_code, ''), 120), finished_at = v_now, updated_at = v_now
      WHERE id = p_job_id RETURNING * INTO v_job;
    WHEN 'cancel' THEN
      IF v_job.state <> 'cancel_requested' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      UPDATE jobs SET state = 'cancelled', timeout_at = NULL,
        finished_at = v_now, updated_at = v_now
      WHERE id = p_job_id RETURNING * INTO v_job;
    ELSE
      RAISE EXCEPTION 'invalid_job_event' USING ERRCODE = 'P0001';
  END CASE;
  RETURN to_jsonb(v_job);
END;
$$;

REVOKE ALL ON FUNCTION transition_job_v2(uuid, integer, text, jsonb, jsonb, text, timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION assert_job_attempt_v1(
  p_job_id uuid,
  p_expected_attempt integer,
  p_expected_type text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.type::text IS DISTINCT FROM p_expected_type THEN
    RAISE EXCEPTION 'job_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_attempt IS NULL OR v_job.attempt <> p_expected_attempt THEN
    RAISE EXCEPTION 'stale_job_attempt' USING ERRCODE = 'P0001';
  END IF;
  IF v_job.state = 'cancel_requested' THEN
    RAISE EXCEPTION 'job_cancel_requested' USING ERRCODE = 'P0001';
  END IF;
  IF v_job.state <> 'running' THEN
    RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001';
  END IF;
  IF v_job.timeout_at IS NULL OR v_job.timeout_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'job_lease_expired' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION assert_job_attempt_v1(uuid, integer, text) FROM PUBLIC;
