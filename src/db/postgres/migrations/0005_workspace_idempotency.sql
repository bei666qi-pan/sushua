ALTER TABLE workspaces
  ADD COLUMN idempotency_key text,
  ADD COLUMN create_request_hash char(64),
  ADD CONSTRAINT workspaces_idempotency_pair CHECK (
    (idempotency_key IS NULL AND create_request_hash IS NULL)
    OR (idempotency_key IS NOT NULL AND create_request_hash IS NOT NULL)
  ),
  ADD CONSTRAINT workspaces_create_request_hash_format CHECK (
    create_request_hash IS NULL OR create_request_hash ~ '^[0-9a-f]{64}$'
  );

CREATE UNIQUE INDEX workspaces_creator_idempotency_unique
  ON workspaces(created_by_learner_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
