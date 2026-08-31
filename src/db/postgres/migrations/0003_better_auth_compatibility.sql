ALTER TABLE auth_sessions
  ALTER COLUMN ip_address TYPE text USING ip_address::text;

ALTER TABLE auth_accounts
  ADD COLUMN issuer text;

UPDATE auth_accounts
SET issuer = 'local:' || provider_id
WHERE issuer IS NULL;

ALTER TABLE auth_accounts
  ALTER COLUMN issuer SET NOT NULL,
  ADD COLUMN id_token_ciphertext text,
  ADD COLUMN password_hash text,
  DROP CONSTRAINT auth_accounts_provider_unique,
  ADD CONSTRAINT auth_accounts_issuer_unique UNIQUE (issuer, account_id);

ALTER TABLE auth_verifications
  DROP CONSTRAINT auth_verifications_value_hash_format,
  ALTER COLUMN value_hash TYPE text,
  ADD CONSTRAINT auth_verifications_value_hash_format
    CHECK (value_hash ~ '^[A-Za-z0-9_-]{43}:[0-9]+$');
