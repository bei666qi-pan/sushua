CREATE TYPE source_asset_upload_state AS ENUM ('initiated', 'uploaded', 'aborted');

ALTER TABLE source_assets
  ADD COLUMN storage_upload_id text,
  ADD COLUMN upload_expires_at timestamptz,
  ADD COLUMN upload_state source_asset_upload_state,
  ADD COLUMN upload_completed_at timestamptz,
  ADD CONSTRAINT source_assets_upload_fields_consistent CHECK (
    (storage_upload_id IS NULL AND upload_expires_at IS NULL AND upload_state IS NULL)
    OR
    (storage_upload_id IS NOT NULL AND upload_expires_at IS NOT NULL AND upload_state IS NOT NULL)
  ),
  ADD CONSTRAINT source_assets_upload_id_length CHECK (
    storage_upload_id IS NULL OR length(storage_upload_id) BETWEEN 1 AND 1024
  );

CREATE UNIQUE INDEX source_assets_workspace_upload_unique
  ON source_assets(workspace_id, storage_upload_id)
  WHERE storage_upload_id IS NOT NULL;
