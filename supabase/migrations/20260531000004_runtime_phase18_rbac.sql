-- Phase 18.8: Runtime RBAC
-- Three-tier role system (viewer / operator / admin) with 8 permissions.
-- If a user has no assignments, all access is allowed for backward compatibility.

CREATE TABLE IF NOT EXISTS runtime_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runtime_permissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_name text NOT NULL UNIQUE,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runtime_role_permissions (
  role_id       uuid NOT NULL REFERENCES runtime_roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES runtime_permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS runtime_role_assignments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  role_id    uuid NOT NULL REFERENCES runtime_roles(id) ON DELETE CASCADE,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS runtime_role_assignments_user_idx
  ON runtime_role_assignments (user_id);

ALTER TABLE runtime_roles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_permissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_role_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_bypass_runtime_roles"
  ON runtime_roles FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_bypass_runtime_permissions"
  ON runtime_permissions FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_bypass_runtime_role_permissions"
  ON runtime_role_permissions FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "service_role_bypass_runtime_role_assignments"
  ON runtime_role_assignments FOR ALL USING (auth.role() = 'service_role');

-- Seed default roles
INSERT INTO runtime_roles (name, description) VALUES
  ('viewer',   'Read-only access to runtime monitoring'),
  ('operator', 'Can manage incidents, commands, workers, and executions'),
  ('admin',    'Full administrative control of the runtime')
ON CONFLICT (name) DO NOTHING;

-- Seed permissions
INSERT INTO runtime_permissions (permission_name, description) VALUES
  ('view_runtime',      'View runtime status and monitoring data'),
  ('manage_workers',    'Start, stop, and restart workers'),
  ('manage_incidents',  'Resolve and escalate incidents'),
  ('manage_commands',   'Retry and dead-letter commands'),
  ('manage_executions', 'Cancel and replay executions'),
  ('view_audit',        'View operator audit log'),
  ('manage_replay',     'Manage and trigger replay operations'),
  ('admin_runtime',     'Full administrative runtime access')
ON CONFLICT (permission_name) DO NOTHING;

-- Seed role-permission mappings
DO $$
DECLARE
  v_viewer_id   uuid;
  v_operator_id uuid;
  v_admin_id    uuid;
  v_perm_id     uuid;
BEGIN
  SELECT id INTO v_viewer_id   FROM runtime_roles WHERE name = 'viewer';
  SELECT id INTO v_operator_id FROM runtime_roles WHERE name = 'operator';
  SELECT id INTO v_admin_id    FROM runtime_roles WHERE name = 'admin';

  -- viewer: view_runtime, view_audit
  FOR v_perm_id IN
    SELECT id FROM runtime_permissions
    WHERE permission_name IN ('view_runtime', 'view_audit')
  LOOP
    INSERT INTO runtime_role_permissions VALUES (v_viewer_id, v_perm_id)
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- operator: all except admin_runtime
  FOR v_perm_id IN
    SELECT id FROM runtime_permissions WHERE permission_name != 'admin_runtime'
  LOOP
    INSERT INTO runtime_role_permissions VALUES (v_operator_id, v_perm_id)
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- admin: all permissions
  FOR v_perm_id IN SELECT id FROM runtime_permissions LOOP
    INSERT INTO runtime_role_permissions VALUES (v_admin_id, v_perm_id)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
