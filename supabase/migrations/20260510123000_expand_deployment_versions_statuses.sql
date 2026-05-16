/*
  Expand deployment_versions status lifecycle for deterministic worker attempts.
*/

DO $$
DECLARE
  constraint_row record;
BEGIN
  FOR constraint_row IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'deployment_versions'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE deployment_versions DROP CONSTRAINT IF EXISTS %I', constraint_row.conname);
  END LOOP;
END $$;

ALTER TABLE deployment_versions
  ADD CONSTRAINT deployment_versions_status_check CHECK (
    status IN ('pending', 'deploying', 'failed', 'active', 'rolled_back', 'superseded')
  );
