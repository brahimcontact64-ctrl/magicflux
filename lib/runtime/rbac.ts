import 'server-only';

import { createServiceClient } from '@/lib/supabase-server';

export type RuntimePermission =
  | 'view_runtime'
  | 'manage_workers'
  | 'manage_incidents'
  | 'manage_commands'
  | 'manage_executions'
  | 'view_audit'
  | 'manage_replay'
  | 'admin_runtime';

export type RuntimeRole = {
  id:          string;
  name:        string;
  description: string | null;
  created_at:  string;
};

export type RoleAssignment = {
  id:         string;
  user_id:    string;
  role_id:    string;
  granted_by: string | null;
  created_at: string;
  role:       RuntimeRole;
};

// Returns all permission names for a user.
// If the user has NO assignments, returns all permissions (backward compat).
export async function getUserPermissions(userId: string): Promise<RuntimePermission[]> {
  const db = createServiceClient();

  const { data: assignments } = await db
    .from('runtime_role_assignments')
    .select('role_id')
    .eq('user_id', userId);

  if (!assignments || assignments.length === 0) {
    // No roles assigned — minimum safe default. Operational permissions require
    // an explicit role assignment. See migration 20260601000004 for the strategy
    // that backfills existing users into the operator role.
    return ['view_runtime'];
  }

  const roleIds = assignments.map(a => a.role_id as string);

  const { data: rolePerms } = await db
    .from('runtime_role_permissions')
    .select('permission_id')
    .in('role_id', roleIds);

  if (!rolePerms || rolePerms.length === 0) return [];

  const permIds = rolePerms.map(rp => rp.permission_id as string);

  const { data: perms } = await db
    .from('runtime_permissions')
    .select('permission_name')
    .in('id', permIds);

  return ((perms ?? []).map(p => p.permission_name as RuntimePermission));
}

export async function hasPermission(
  userId: string,
  permission: RuntimePermission
): Promise<boolean> {
  const perms = await getUserPermissions(userId);
  return perms.includes(permission) || perms.includes('admin_runtime');
}

// Throws a 403-style error if user lacks the permission.
export async function requirePermission(
  userId: string,
  permission: RuntimePermission
): Promise<void> {
  const ok = await hasPermission(userId, permission);
  if (!ok) {
    throw Object.assign(new Error(`Permission denied: ${permission}`), { status: 403 });
  }
}

export async function getUserRoles(userId: string): Promise<RoleAssignment[]> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_role_assignments')
    .select('id, user_id, role_id, granted_by, created_at, runtime_roles!runtime_role_assignments_role_id_fkey(id, name, description, created_at)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  return ((data ?? []) as Array<Record<string, unknown>>).map(r => ({
    id:         r.id         as string,
    user_id:    r.user_id    as string,
    role_id:    r.role_id    as string,
    granted_by: r.granted_by as string | null,
    created_at: r.created_at as string,
    role:       r.runtime_roles as RuntimeRole,
  }));
}

export async function assignRole(params: {
  userId:    string;
  roleName:  string;
  grantedBy: string;
}): Promise<RoleAssignment | null> {
  const db = createServiceClient();

  const { data: role } = await db
    .from('runtime_roles')
    .select('id, name, description, created_at')
    .eq('name', params.roleName)
    .maybeSingle();

  if (!role) return null;

  const { data } = await db
    .from('runtime_role_assignments')
    .upsert({
      user_id:    params.userId,
      role_id:    role.id,
      granted_by: params.grantedBy,
    }, { onConflict: 'user_id,role_id' })
    .select('id, user_id, role_id, granted_by, created_at')
    .single();

  if (!data) return null;

  return {
    id:         data.id as string,
    user_id:    data.user_id as string,
    role_id:    data.role_id as string,
    granted_by: data.granted_by as string | null,
    created_at: data.created_at as string,
    role:       role as RuntimeRole,
  };
}

export async function revokeRole(params: {
  userId:   string;
  roleName: string;
}): Promise<boolean> {
  const db = createServiceClient();

  const { data: role } = await db
    .from('runtime_roles')
    .select('id')
    .eq('name', params.roleName)
    .maybeSingle();

  if (!role) return false;

  const { error } = await db
    .from('runtime_role_assignments')
    .delete()
    .eq('user_id', params.userId)
    .eq('role_id', role.id);

  return !error;
}

export async function listAllRoles(): Promise<RuntimeRole[]> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_roles')
    .select('*')
    .order('name');

  return (data ?? []) as RuntimeRole[];
}

export async function listAllRoleAssignments(): Promise<
  Array<{ user_id: string; role_name: string; granted_by: string | null; created_at: string }>
> {
  const db = createServiceClient();
  const { data } = await db
    .from('runtime_role_assignments')
    .select('user_id, granted_by, created_at, runtime_roles!runtime_role_assignments_role_id_fkey(name)')
    .order('created_at', { ascending: false })
    .limit(500);

  return ((data ?? []) as Array<Record<string, unknown>>).map(r => ({
    user_id:    r.user_id    as string,
    role_name:  (r.runtime_roles as { name?: string } | null)?.name ?? '',
    granted_by: r.granted_by as string | null,
    created_at: r.created_at as string,
  }));
}
