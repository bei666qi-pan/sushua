CREATE OR REPLACE FUNCTION schedule_document_parse_v1(
  p_scan_job_id uuid,
  p_parse_job_id uuid,
  p_trace_id uuid,
  p_request_hash text,
  p_requested_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_scan jobs%ROWTYPE;
  v_asset source_assets%ROWTYPE;
  v_version document_versions%ROWTYPE;
  v_parse jobs%ROWTYPE;
  v_key text;
BEGIN
  IF p_requested_at IS NULL OR p_requested_at > now() + interval '5 minutes'
    OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_parse_schedule' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_scan FROM jobs WHERE id = p_scan_job_id FOR UPDATE;
  IF NOT FOUND OR v_scan.type <> 'file.scan' OR v_scan.state <> 'running' THEN
    RAISE EXCEPTION 'parse_schedule_scan_not_found' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_asset
  FROM source_assets
  WHERE id = v_scan.resource_id AND workspace_id = v_scan.workspace_id
  FOR UPDATE;
  IF NOT FOUND OR v_asset.scan_status <> 'clean' OR v_asset.scan_job_id IS DISTINCT FROM p_scan_job_id THEN
    RAISE EXCEPTION 'parse_schedule_scan_not_clean' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_version
  FROM document_versions
  WHERE id = v_asset.document_version_id AND workspace_id = v_asset.workspace_id
  FOR UPDATE;
  IF NOT FOUND OR v_version.status NOT IN ('scanned', 'parsing', 'ready') THEN
    RAISE EXCEPTION 'parse_schedule_version_not_ready' USING ERRCODE = 'P0001';
  END IF;

  v_key := 'document.parse:' || v_version.id::text;
  INSERT INTO jobs(
    id,resource_id,type,workspace_id,idempotency_key,request_hash,schema_version,trace_id,learner_id,
    priority,budget,state,progress,attempt,max_attempts,run_after,requested_at,updated_at
  ) VALUES(
    p_parse_job_id,v_version.id,'document.parse',v_version.workspace_id,v_key,p_request_hash,1,p_trace_id,
    v_scan.learner_id,0,'{}','queued',
    jsonb_build_object('phase','queued','percent',0,'updatedAt',p_requested_at),
    0,3,p_requested_at,p_requested_at,p_requested_at
  )
  ON CONFLICT (workspace_id,type,idempotency_key) DO NOTHING;

  SELECT * INTO v_parse FROM jobs
  WHERE workspace_id = v_version.workspace_id AND type = 'document.parse' AND idempotency_key = v_key;
  IF NOT FOUND OR v_parse.resource_id IS DISTINCT FROM v_version.id
    OR v_parse.request_hash IS DISTINCT FROM p_request_hash THEN
    RAISE EXCEPTION 'parse_schedule_conflict' USING ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', v_parse.schema_version,
    'id', v_parse.id,
    'type', v_parse.type,
    'workspaceId', v_parse.workspace_id,
    'learnerId', v_parse.learner_id,
    'resourceId', v_parse.resource_id,
    'idempotencyKey', v_parse.idempotency_key,
    'traceId', v_parse.trace_id,
    'requestedAt', to_char(v_parse.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'priority', v_parse.priority,
    'budget', v_parse.budget
  ));
END;
$$;

REVOKE ALL ON FUNCTION schedule_document_parse_v1(uuid, uuid, uuid, text, timestamptz) FROM PUBLIC;
