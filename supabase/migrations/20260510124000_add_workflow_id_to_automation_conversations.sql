/*
  Ensure conversation-to-workflow linkage column exists for production deploy persistence checks.
*/

ALTER TABLE IF EXISTS automation_conversations
  ADD COLUMN IF NOT EXISTS workflow_id text;

CREATE INDEX IF NOT EXISTS automation_conversations_workflow_id_idx
  ON automation_conversations(workflow_id, updated_at DESC);
