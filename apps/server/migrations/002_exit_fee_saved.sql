-- 002_exit_fee_saved: closing fee waived by Delta's Scalper Offer (or its simulation) on a trade, in USD.
-- NULL on rows written before this migration (and on open / failed trades); readers treat NULL as "unknown / none".
ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_fee_saved double precision;
