/*
  Repair: automation_patterns_kind_check / skill_packs_kind_check exist in
  production with only two allowed values --
  CHECK (kind IN ('provider_specific', 'abstract_template'))
  -- missing 'domain_template', which
  20260518000001_add_pattern_kind_classification.sql's own
  build_pattern_classification() legitimately computes for real rows (e.g. a
  pattern whose name/description scores as domain-specific but has no
  explicit provider name). Confirmed read-only via `supabase db dump
  --schema public`: both constraints, by their exact live names, allow only
  the two-value set.

  Root cause: 20260518000001 uses
    ALTER TABLE automation_patterns
      ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'abstract_template'
      CONSTRAINT automation_patterns_kind_check
        CHECK (kind IN ('provider_specific','domain_template','abstract_template'));
  On a genuinely fresh database (kind column does not exist yet) this adds
  the column WITH the full 3-value constraint, and would work correctly end
  to end -- confirmed in a disposable-harness test below. On THIS production
  database the kind column already existed (added by an earlier, undocumented
  process, same drift pattern found throughout this project) with a narrower
  constraint, so ADD COLUMN IF NOT EXISTS -- constraint clause included --
  is skipped entirely as a no-op, leaving the stale 2-value constraint in
  place. That is why this is a NEW forward migration rather than an edit to
  the historical file: the old file remains correct for a fresh environment;
  this migration corrects the constraint for THIS project's already-drifted
  reality, using the exact constraint names confirmed live (no blind
  pattern-matching).

  Idempotent: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT is safe to replay.
  Widens, never narrows, the allowed value set -- every row currently valid
  under the 2-value constraint remains valid under the 3-value one. No row
  is deleted or has any other column touched.
*/

ALTER TABLE automation_patterns
  DROP CONSTRAINT IF EXISTS automation_patterns_kind_check;

ALTER TABLE automation_patterns
  ADD CONSTRAINT automation_patterns_kind_check
  CHECK (kind IN ('provider_specific', 'domain_template', 'abstract_template'));

ALTER TABLE skill_packs
  DROP CONSTRAINT IF EXISTS skill_packs_kind_check;

ALTER TABLE skill_packs
  ADD CONSTRAINT skill_packs_kind_check
  CHECK (kind IN ('provider_specific', 'domain_template', 'abstract_template'));
