CREATE TYPE job_type AS ENUM ('file.scan', 'document.parse', 'document.cleanup');
CREATE TYPE job_state AS ENUM (
  'queued', 'running', 'succeeded', 'partially_succeeded', 'failed',
  'dead_lettered', 'cancel_requested', 'cancelled'
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  learner_id uuid REFERENCES learners(id) ON DELETE SET NULL,
  resource_id uuid NOT NULL,
  type job_type NOT NULL,
  state job_state NOT NULL DEFAULT 'queued',
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  trace_id uuid NOT NULL,
  priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN -10 AND 10),
  budget jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(budget) = 'object' AND octet_length(budget::text) <= 2048),
  progress jsonb NOT NULL
    CHECK (jsonb_typeof(progress) = 'object' AND octet_length(progress::text) <= 4096),
  checkpoint jsonb
    CHECK (checkpoint IS NULL OR (jsonb_typeof(checkpoint) = 'object' AND octet_length(checkpoint::text) <= 16384)),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  run_after timestamptz NOT NULL,
  timeout_at timestamptz,
  error_code text,
  cancel_reason text,
  requested_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT jobs_id_uuidv7 CHECK (substring(id::text FROM 15 FOR 1) = '7'),
  CONSTRAINT jobs_resource_id_uuidv7 CHECK (substring(resource_id::text FROM 15 FOR 1) = '7'),
  CONSTRAINT jobs_trace_id_uuidv7 CHECK (substring(trace_id::text FROM 15 FOR 1) = '7'),
  CONSTRAINT jobs_idempotency_key_length CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT jobs_request_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT jobs_workspace_type_idempotency_unique UNIQUE (workspace_id, type, idempotency_key)
);
CREATE INDEX jobs_workspace_created_idx ON jobs(workspace_id, requested_at, id);
CREATE INDEX jobs_runnable_idx ON jobs(state, run_after, priority DESC, requested_at, id)
  WHERE state IN ('queued', 'cancel_requested');

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY jobs_member_select ON jobs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM workspace_members wm
      WHERE wm.workspace_id = jobs.workspace_id
        AND wm.learner_id = app_current_learner_id()
    )
  );

CREATE OR REPLACE FUNCTION submit_job_v1(
  p_candidate_job_id uuid,
  p_resource_id uuid,
  p_type text,
  p_workspace_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_priority integer,
  p_budget jsonb,
  p_max_attempts integer,
  p_trace_id uuid,
  p_learner_id uuid,
  p_requested_at timestamptz
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
  IF app_current_learner_id() IS DISTINCT FROM p_learner_id
    OR app_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'invalid_job_context' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM workspace_members wm
    WHERE wm.workspace_id = p_workspace_id
      AND wm.learner_id = p_learner_id
      AND wm.role IN ('owner', 'editor')
  ) THEN
    RAISE EXCEPTION 'job_workspace_forbidden' USING ERRCODE = 'P0001';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 200
    OR btrim(p_idempotency_key) <> p_idempotency_key THEN
    RAISE EXCEPTION 'invalid_job_idempotency_key' USING ERRCODE = 'P0001';
  END IF;
  IF p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_job_request_hash' USING ERRCODE = 'P0001';
  END IF;
  IF p_priority NOT BETWEEN -10 AND 10 OR p_max_attempts NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'invalid_job_limits' USING ERRCODE = 'P0001';
  END IF;
  IF p_budget IS NULL
    OR jsonb_typeof(p_budget) <> 'object'
    OR octet_length(p_budget::text) > 2048
    OR p_budget - ARRAY['maxCostFen', 'maxTokens'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid_job_budget' USING ERRCODE = 'P0001';
  END IF;
  IF p_budget ? 'maxCostFen' THEN
    IF jsonb_typeof(p_budget->'maxCostFen') <> 'number' THEN
      RAISE EXCEPTION 'invalid_job_budget' USING ERRCODE = 'P0001';
    END IF;
    IF (p_budget->>'maxCostFen')::numeric < 0 THEN
      RAISE EXCEPTION 'invalid_job_budget' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF p_budget ? 'maxTokens' THEN
    IF jsonb_typeof(p_budget->'maxTokens') <> 'number' THEN
      RAISE EXCEPTION 'invalid_job_budget' USING ERRCODE = 'P0001';
    END IF;
    IF (p_budget->>'maxTokens')::numeric < 0
      OR (p_budget->>'maxTokens')::numeric <> trunc((p_budget->>'maxTokens')::numeric) THEN
      RAISE EXCEPTION 'invalid_job_budget' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_workspace_id::text || ':' || p_type || ':' || p_idempotency_key,
    0
  ));
  SELECT * INTO v_job
  FROM jobs
  WHERE workspace_id = p_workspace_id
    AND type = p_type::job_type
    AND idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_job.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'job_idempotency_conflict' USING ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object('status', 'replayed', 'job', to_jsonb(v_job));
  END IF;

  INSERT INTO jobs (
    id, workspace_id, learner_id, resource_id, type, idempotency_key, request_hash,
    trace_id, priority, budget, progress, max_attempts, run_after, requested_at, updated_at
  ) VALUES (
    p_candidate_job_id, p_workspace_id, p_learner_id, p_resource_id, p_type::job_type,
    p_idempotency_key, p_request_hash, p_trace_id, p_priority, p_budget,
    jsonb_build_object('phase', 'queued', 'percent', 0, 'updatedAt', p_requested_at),
    p_max_attempts, p_requested_at, p_requested_at, p_requested_at
  )
  RETURNING * INTO v_job;
  v_status := 'created';
  RETURN jsonb_build_object('status', v_status, 'job', to_jsonb(v_job));
END;
$$;
REVOKE ALL ON FUNCTION submit_job_v1(uuid, uuid, text, uuid, text, text, integer, jsonb, integer, uuid, uuid, timestamptz) FROM PUBLIC;

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
    AND j.workspace_id = app_current_workspace_id()
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

CREATE OR REPLACE FUNCTION transition_job_v1(
  p_job_id uuid,
  p_event text,
  p_progress jsonb,
  p_checkpoint jsonb,
  p_error_code text,
  p_run_after timestamptz,
  p_event_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF p_event_at IS NULL OR p_event_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'invalid_job_event_time' USING ERRCODE = 'P0001';
  END IF;
  IF p_event_at < v_job.updated_at THEN
    RAISE EXCEPTION 'stale_job_event' USING ERRCODE = 'P0001';
  END IF;

  CASE p_event
    WHEN 'start' THEN
      IF v_job.state <> 'queued' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      IF v_job.attempt >= v_job.max_attempts THEN RAISE EXCEPTION 'job_attempts_exhausted' USING ERRCODE = 'P0001'; END IF;
      UPDATE jobs SET state = 'running', attempt = attempt + 1,
        started_at = COALESCE(started_at, p_event_at), updated_at = p_event_at, error_code = NULL
      WHERE id = p_job_id RETURNING * INTO v_job;
    WHEN 'progress' THEN
      IF v_job.state <> 'running' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      IF p_progress IS NULL
        OR jsonb_typeof(p_progress) <> 'object'
        OR octet_length(p_progress::text) > 4096
        OR p_progress - ARRAY['phase', 'percent', 'current', 'total', 'messageCode', 'updatedAt'] <> '{}'::jsonb
        OR NOT p_progress ? 'phase'
        OR NOT p_progress ? 'percent'
        OR NOT p_progress ? 'updatedAt'
        OR jsonb_typeof(p_progress->'phase') <> 'string'
        OR jsonb_typeof(p_progress->'percent') <> 'number'
        OR jsonb_typeof(p_progress->'updatedAt') <> 'string' THEN
        RAISE EXCEPTION 'invalid_job_progress' USING ERRCODE = 'P0001';
      END IF;
      IF (p_progress->>'percent')::numeric NOT BETWEEN 0 AND 100 THEN
        RAISE EXCEPTION 'invalid_job_progress' USING ERRCODE = 'P0001';
      END IF;
      IF p_progress ? 'current' THEN
        IF jsonb_typeof(p_progress->'current') <> 'number' THEN
          RAISE EXCEPTION 'invalid_job_progress' USING ERRCODE = 'P0001';
        END IF;
        IF (p_progress->>'current')::numeric < 0
          OR (p_progress->>'current')::numeric <> trunc((p_progress->>'current')::numeric) THEN
          RAISE EXCEPTION 'invalid_job_progress' USING ERRCODE = 'P0001';
        END IF;
      END IF;
      IF p_progress ? 'total' THEN
        IF jsonb_typeof(p_progress->'total') <> 'number' THEN
          RAISE EXCEPTION 'invalid_job_progress' USING ERRCODE = 'P0001';
        END IF;
        IF (p_progress->>'total')::numeric < 0
          OR (p_progress->>'total')::numeric <> trunc((p_progress->>'total')::numeric) THEN
          RAISE EXCEPTION 'invalid_job_progress' USING ERRCODE = 'P0001';
        END IF;
      END IF;
      IF p_progress ? 'messageCode' AND jsonb_typeof(p_progress->'messageCode') <> 'string' THEN
        RAISE EXCEPTION 'invalid_job_progress' USING ERRCODE = 'P0001';
      END IF;
      UPDATE jobs SET progress = p_progress,
        checkpoint = COALESCE(p_checkpoint, checkpoint), updated_at = p_event_at
      WHERE id = p_job_id RETURNING * INTO v_job;
    WHEN 'retry' THEN
      IF v_job.state <> 'running' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      IF v_job.attempt >= v_job.max_attempts THEN RAISE EXCEPTION 'job_attempts_exhausted' USING ERRCODE = 'P0001'; END IF;
      UPDATE jobs SET state = 'queued', error_code = left(NULLIF(p_error_code, ''), 120),
        run_after = COALESCE(p_run_after, p_event_at), updated_at = p_event_at
      WHERE id = p_job_id RETURNING * INTO v_job;
    WHEN 'succeed' THEN
      IF v_job.state <> 'running' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      UPDATE jobs SET state = 'succeeded', checkpoint = COALESCE(p_checkpoint, checkpoint),
        finished_at = p_event_at, updated_at = p_event_at
      WHERE id = p_job_id RETURNING * INTO v_job;
    WHEN 'partial_succeed' THEN
      IF v_job.state <> 'running' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      UPDATE jobs SET state = 'partially_succeeded', checkpoint = COALESCE(p_checkpoint, checkpoint),
        error_code = left(NULLIF(p_error_code, ''), 120), finished_at = p_event_at, updated_at = p_event_at
      WHERE id = p_job_id RETURNING * INTO v_job;
    WHEN 'fail' THEN
      IF v_job.state <> 'running' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      UPDATE jobs SET state = 'failed', error_code = left(NULLIF(p_error_code, ''), 120),
        finished_at = p_event_at, updated_at = p_event_at
      WHERE id = p_job_id RETURNING * INTO v_job;
    WHEN 'dead_letter' THEN
      IF v_job.state <> 'running' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      UPDATE jobs SET state = 'dead_lettered', error_code = left(NULLIF(p_error_code, ''), 120),
        finished_at = p_event_at, updated_at = p_event_at
      WHERE id = p_job_id RETURNING * INTO v_job;
    WHEN 'cancel' THEN
      IF v_job.state <> 'cancel_requested' THEN RAISE EXCEPTION 'invalid_job_transition' USING ERRCODE = 'P0001'; END IF;
      UPDATE jobs SET state = 'cancelled', finished_at = p_event_at, updated_at = p_event_at
      WHERE id = p_job_id RETURNING * INTO v_job;
    ELSE
      RAISE EXCEPTION 'invalid_job_event' USING ERRCODE = 'P0001';
  END CASE;
  RETURN to_jsonb(v_job);
END;
$$;
REVOKE ALL ON FUNCTION transition_job_v1(uuid, text, jsonb, jsonb, text, timestamptz, timestamptz) FROM PUBLIC;
