-- Additive D3C-C: shared, atomic service-token replay protection across DDI instances.
-- Only SHA-256(issuer, jti) is stored; rows expire with the token (plus clock skew).
CREATE TABLE IF NOT EXISTS ddi_service_token_replay (
  jti_hash TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS ddi_service_token_replay_expiry_idx ON ddi_service_token_replay (expires_at);
