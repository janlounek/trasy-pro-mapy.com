-- Privacy: remove cached real names from existing data. Columns are kept for
-- backward compatibility (older deployed Workers may still try to read them)
-- but always set to NULL going forward — see verifyToken / upsertRoute in
-- src/index.ts.
--
-- Safe to re-run; UPDATE … = NULL is idempotent.

UPDATE shared_routes SET owner_name = NULL;
UPDATE token_cache SET user_name = NULL;
