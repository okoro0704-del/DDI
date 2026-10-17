-- Additive D3B commercial activation model. Activation codes are stored only as
-- keyed hashes; download grants only as token hashes. Commercial records never
-- own a property or create a PDI: they reference the owner's PERSONAL PDI.
CREATE TABLE IF NOT EXISTS ddi_commercial_operators (
  owner_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('COMMERCIAL_ISSUER', 'COMMERCIAL_ADMIN')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  granted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ddi_activation_codes (
  id TEXT PRIMARY KEY,
  lookup_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  hash_version TEXT NOT NULL,
  product_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_snapshot JSONB NOT NULL,
  catalog_version TEXT NOT NULL,
  payment_reference TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  issue_idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ISSUED', 'REDEEMED', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_by_owner_id TEXT,
  redeemed_at TIMESTAMPTZ,
  redemption_id TEXT,
  revoked_at TIMESTAMPTZ,
  revoked_by TEXT,
  CHECK (expires_at > created_at),
  CHECK ((status = 'REDEEMED') = (redeemed_by_owner_id IS NOT NULL AND redeemed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ddi_activation_codes_lookup_uidx ON ddi_activation_codes (lookup_id);
CREATE UNIQUE INDEX IF NOT EXISTS ddi_activation_codes_issue_uidx ON ddi_activation_codes (issued_by, issue_idempotency_key);

CREATE TABLE IF NOT EXISTS ddi_entitlements (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  infrastructure_id TEXT NOT NULL REFERENCES ddi_infrastructures(id),
  product_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  edition TEXT NOT NULL,
  license_type TEXT NOT NULL CHECK (license_type IN ('PERPETUAL', 'TERM')),
  property_id TEXT REFERENCES ddi_connected_properties(id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED')),
  activated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  renewable BOOLEAN NOT NULL,
  downloads JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_code_id TEXT NOT NULL REFERENCES ddi_activation_codes(id),
  status_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ddi_entitlements_source_code_uidx ON ddi_entitlements (source_code_id);
CREATE INDEX IF NOT EXISTS ddi_entitlements_owner_idx ON ddi_entitlements (owner_id, created_at);

CREATE TABLE IF NOT EXISTS ddi_licenses (
  id TEXT PRIMARY KEY,
  entitlement_id TEXT NOT NULL REFERENCES ddi_entitlements(id),
  owner_id TEXT NOT NULL,
  infrastructure_id TEXT NOT NULL REFERENCES ddi_infrastructures(id),
  product_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  property_id TEXT REFERENCES ddi_connected_properties(id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED')),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  restrictions JSONB NOT NULL DEFAULT '{}'::jsonb,
  revision INTEGER NOT NULL DEFAULT 1,
  status_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ddi_licenses_entitlement_uidx ON ddi_licenses (entitlement_id);
CREATE INDEX IF NOT EXISTS ddi_licenses_owner_idx ON ddi_licenses (owner_id, created_at);

CREATE TABLE IF NOT EXISTS ddi_activation_redemptions (
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL REFERENCES ddi_activation_codes(id),
  owner_id TEXT NOT NULL,
  owner_trust_subject TEXT,
  idempotency_key TEXT NOT NULL,
  infrastructure_id TEXT NOT NULL REFERENCES ddi_infrastructures(id),
  property_id TEXT REFERENCES ddi_connected_properties(id),
  entitlement_id TEXT NOT NULL REFERENCES ddi_entitlements(id),
  license_id TEXT NOT NULL REFERENCES ddi_licenses(id),
  status TEXT NOT NULL CHECK (status IN ('PROVISIONING_PENDING', 'COMPLETED', 'ATTENTION_REQUIRED', 'CANCELLED')),
  provisioning_reference TEXT,
  provisioned_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ddi_activation_redemptions_code_uidx ON ddi_activation_redemptions (code_id);
CREATE UNIQUE INDEX IF NOT EXISTS ddi_activation_redemptions_owner_key_uidx ON ddi_activation_redemptions (owner_id, idempotency_key);

-- Durable cross-service provisioning. Payloads hold record ids only.
CREATE TABLE IF NOT EXISTS ddi_commercial_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'IN_PROGRESS', 'DONE', 'DEAD')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_token TEXT,
  locked_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ddi_commercial_outbox_dedupe_uidx ON ddi_commercial_outbox (dedupe_key);
CREATE INDEX IF NOT EXISTS ddi_commercial_outbox_due_idx ON ddi_commercial_outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS ddi_download_grants (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  license_id TEXT NOT NULL REFERENCES ddi_licenses(id),
  entitlement_id TEXT NOT NULL REFERENCES ddi_entitlements(id),
  product_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  property_id TEXT REFERENCES ddi_connected_properties(id),
  status TEXT NOT NULL CHECK (status IN ('ISSUED', 'CONSUMED')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ddi_download_grants_token_uidx ON ddi_download_grants (token_hash);

CREATE TABLE IF NOT EXISTS ddi_commercial_audits (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  actor TEXT,
  owner_id TEXT,
  code_id TEXT,
  entitlement_id TEXT,
  license_id TEXT,
  property_id TEXT,
  redemption_id TEXT,
  product_id TEXT,
  result TEXT NOT NULL,
  reason TEXT,
  timestamp TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS ddi_commercial_audits_owner_event_idx ON ddi_commercial_audits (owner_id, event_type, timestamp);
