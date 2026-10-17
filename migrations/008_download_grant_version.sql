-- Additive D3C-B: a download grant names one exact artifact version.
-- Grants issued before this migration have NULL and can never be fulfilled by
-- Master Distributor, which always redeems for a specific version.
ALTER TABLE ddi_download_grants ADD COLUMN IF NOT EXISTS artifact_version TEXT;
