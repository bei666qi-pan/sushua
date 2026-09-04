ALTER TABLE document_revisions
  ADD COLUMN idempotency_key text,
  ADD COLUMN request_hash char(64);

UPDATE document_revisions
   SET idempotency_key = 'legacy:' || id::text,
       request_hash = repeat('0', 64)
 WHERE idempotency_key IS NULL OR request_hash IS NULL;

ALTER TABLE document_revisions
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN request_hash SET NOT NULL,
  ADD CONSTRAINT document_revisions_idempotency_key_length CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  ADD CONSTRAINT document_revisions_request_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT document_revisions_workspace_document_idempotency_unique
    UNIQUE (workspace_id, document_id, idempotency_key);

CREATE INDEX document_revisions_workspace_document_created_idx
  ON document_revisions(workspace_id, document_id, created_at, id);
