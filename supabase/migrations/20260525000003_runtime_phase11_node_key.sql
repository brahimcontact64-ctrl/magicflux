/*
  Phase 11: Precise node quarantine key separator

  Change detect_repeated_node_failures to use ':' as the separator between
  workflow_id and node_id.  The old '_' separator was ambiguous when node IDs
  themselves contained underscores.  ':' is not a valid UUID or n8n ID
  character, so it is unambiguous and allows exact-match enforcement.

  All quarantine targets written after this migration have the format:
    workflowId:nodeId

  Self-healer normalises legacy '_'-format keys on read so existing records
  continue to work during the transition window.
*/

CREATE OR REPLACE FUNCTION detect_repeated_node_failures(
  p_threshold      integer DEFAULT 5,
  p_window_minutes integer DEFAULT 10
)
RETURNS TABLE(
  node_key     text,
  workflow_id  text,
  execution_id text,
  user_id      text,
  failure_count bigint
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    COALESCE(rns.workflow_id::text, '') || ':' || COALESCE(rns.node_id::text, '')
                                                                       AS node_key,
    COALESCE(rns.workflow_id::text, '')                                AS workflow_id,
    (array_agg(rns.execution_id::text ORDER BY rns.updated_at DESC))[1] AS execution_id,
    (array_agg(rns.user_id::text      ORDER BY rns.updated_at DESC))[1] AS user_id,
    COUNT(*)                                                             AS failure_count
  FROM runtime_node_states rns
  WHERE rns.status = 'failed'
    AND rns.updated_at >= NOW() - make_interval(mins => p_window_minutes)
  GROUP BY rns.workflow_id, rns.node_id
  HAVING COUNT(*) >= p_threshold
  LIMIT 100
$$;
