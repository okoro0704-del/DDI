-- Additive DDI runtime columns. Does not reinterpret owner_subject as a Digi owner id.
ALTER TABLE ddi_infrastructures ADD COLUMN IF NOT EXISTS owner_id TEXT;
ALTER TABLE ddi_idempotency ADD COLUMN IF NOT EXISTS owner_id TEXT;
ALTER TABLE ddi_audits ADD COLUMN IF NOT EXISTS owner_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ddi_bindings_infra_namespace_uidx ON ddi_primitive_bindings (infrastructure_id, namespace);
