/*
  # Phase 16 Follow-up: Allow Dynamic Providers in user_integrations

  Removes legacy static-provider-only constraint and replaces it with
  a safe normalized provider format constraint.
*/

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'user_integrations'
      AND c.conname = 'user_integrations_provider_check'
  ) THEN
    ALTER TABLE public.user_integrations
      DROP CONSTRAINT user_integrations_provider_check;
  END IF;
END $$;

ALTER TABLE public.user_integrations
  ADD CONSTRAINT user_integrations_provider_check
  CHECK (provider ~ '^[a-z0-9._-]+$');
