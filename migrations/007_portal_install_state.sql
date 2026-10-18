-- Additive D3C-B Portal -> DDI install-state propagation.
-- Events carry the install's full DDI-relevant state and a per-install sequence;
-- only a strictly newer sequence may change state, so duplicates and late
-- deliveries are inert. Every received event id is recorded exactly once.
CREATE TABLE IF NOT EXISTS ddi_portal_install_events (
  event_id TEXT PRIMARY KEY,
  external_reference TEXT NOT NULL,
  event_type TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  owner_subject TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  source_service TEXT NOT NULL,
  outcome TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS ddi_portal_install_events_ref_idx ON ddi_portal_install_events (external_reference, sequence);

CREATE TABLE IF NOT EXISTS ddi_portal_install_state (
  external_reference TEXT PRIMARY KEY,
  property_id TEXT REFERENCES ddi_connected_properties(id),
  last_sequence BIGINT NOT NULL DEFAULT -1,
  install_suspended BOOLEAN NOT NULL DEFAULT FALSE,
  owner_suspended BOOLEAN NOT NULL DEFAULT FALSE,
  retired BOOLEAN NOT NULL DEFAULT FALSE,
  owner_mismatch BOOLEAN NOT NULL DEFAULT FALSE,
  reconcile_restricted BOOLEAN NOT NULL DEFAULT FALSE,
  restricted_from TEXT,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);
