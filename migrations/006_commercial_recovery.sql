-- Additive D3C-A operator recovery. A requeue resets attempts but is itself
-- bounded per job, so total retries stay finite and every requeue is audited.
ALTER TABLE ddi_commercial_outbox ADD COLUMN IF NOT EXISTS requeue_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ddi_commercial_outbox ADD COLUMN IF NOT EXISTS max_requeues INTEGER NOT NULL DEFAULT 3;
