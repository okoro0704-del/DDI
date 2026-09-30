-- Additive PDI connection lifecycle. One PERSONAL infrastructure per Digi owner.
ALTER TABLE ddi_applications ADD COLUMN IF NOT EXISTS credential_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ddi_applications_credential_hash_uidx ON ddi_applications (credential_hash) WHERE credential_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ddi_personal_owner_uidx ON ddi_infrastructures (owner_id) WHERE type = 'PERSONAL' AND owner_id <> '';
CREATE TABLE IF NOT EXISTS ddi_connections (
  id TEXT PRIMARY KEY,
  infrastructure_id TEXT NOT NULL REFERENCES ddi_infrastructures(id),
  application_id TEXT NOT NULL REFERENCES ddi_applications(id),
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_capabilities JSONB NOT NULL,
  approved_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  pending_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  authority_grant_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ddi_connections_infra_app_uidx ON ddi_connections (infrastructure_id, application_id);
CREATE TABLE IF NOT EXISTS ddi_connection_audits (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  owner_id TEXT,
  infrastructure_id TEXT NOT NULL,
  application_id TEXT,
  connection_id TEXT,
  capability TEXT,
  grant_id TEXT,
  result TEXT NOT NULL,
  reason TEXT,
  timestamp TIMESTAMPTZ NOT NULL
);
ALTER TABLE ddi_audits ADD COLUMN IF NOT EXISTS connection_id TEXT;
