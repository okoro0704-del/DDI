-- Additive D1 model. Connected properties belong to a PDI; they never become PDI owners.
CREATE TABLE IF NOT EXISTS ddi_connected_properties (
  id TEXT PRIMARY KEY,
  infrastructure_id TEXT NOT NULL REFERENCES ddi_infrastructures(id),
  owner_id TEXT NOT NULL,
  property_type TEXT NOT NULL,
  external_system TEXT NOT NULL,
  external_reference TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  ownership_evidence TEXT NOT NULL,
  provisioning_idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS ddi_connected_properties_external_uidx ON ddi_connected_properties (external_system, external_reference);
CREATE UNIQUE INDEX IF NOT EXISTS ddi_connected_properties_pdi_external_uidx ON ddi_connected_properties (infrastructure_id, external_system, external_reference);
CREATE UNIQUE INDEX IF NOT EXISTS ddi_connected_properties_idempotency_uidx ON ddi_connected_properties (owner_id, provisioning_idempotency_key);
CREATE INDEX IF NOT EXISTS ddi_connected_properties_pdi_status_idx ON ddi_connected_properties (infrastructure_id, status, created_at);
ALTER TABLE ddi_applications ADD COLUMN IF NOT EXISTS property_id TEXT REFERENCES ddi_connected_properties(id);
ALTER TABLE ddi_audits ADD COLUMN IF NOT EXISTS property_id TEXT;
ALTER TABLE ddi_connection_audits ADD COLUMN IF NOT EXISTS property_id TEXT;
