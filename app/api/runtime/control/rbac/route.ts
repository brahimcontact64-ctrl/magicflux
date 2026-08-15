import { NextRequest, NextResponse } from 'next/server';

import { getUserFromRequest } from '@/lib/supabase-server';
import {
  listAllRoles,
  listAllRoleAssignments,
  getUserRoles,
  assignRole,
  revokeRole,
  getUserPermissions,
  requirePermission,
} from '@/lib/runtime/rbac';

// GET — RBAC overview: roles, all assignments (admin), or a single user's roles.
//
// Query params:
//   ?user_id=<uuid>   — fetch roles for a specific user
//   ?me=true          — fetch roles + permissions for the authenticated user
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp     = req.nextUrl.searchParams;
  const userId = sp.get('user_id');
  const me     = sp.get('me') === 'true';

  // Any authenticated user may read their own roles and permissions.
  if (me || (userId && userId === user.id)) {
    const [roles, permissions] = await Promise.all([
      getUserRoles(user.id),
      getUserPermissions(user.id),
    ]);
    return NextResponse.json({ roles, permissions, userId: user.id });
  }

  // Listing all assignments or another user's roles requires admin_runtime.
  try {
    await requirePermission(user.id, 'admin_runtime');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const [allRoles, assignments] = await Promise.all([
    listAllRoles(),
    listAllRoleAssignments(),
  ]);

  const targetRoles = userId
    ? await getUserRoles(userId)
    : undefined;

  return NextResponse.json({
    roles:       allRoles,
    assignments,
    ...(targetRoles ? { userRoles: targetRoles, userId } : {}),
    generatedAt: new Date().toISOString(),
  });
}

// POST — assign or revoke a role.
//
// Body variants:
//   { action: 'assign'; userId: string; roleName: string }
//   { action: 'revoke'; userId: string; roleName: string }
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    await requirePermission(user.id, 'admin_runtime');
  } catch {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { action, userId, roleName } = body as Record<string, unknown>;

  if (typeof userId !== 'string' || !userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }
  if (typeof roleName !== 'string' || !roleName) {
    return NextResponse.json({ error: 'roleName is required' }, { status: 400 });
  }

  if (action === 'assign') {
    const assignment = await assignRole({
      userId:    userId as string,
      roleName:  roleName as string,
      grantedBy: user.id,
    });

    if (!assignment) {
      return NextResponse.json({ error: `Role '${roleName}' not found` }, { status: 404 });
    }

    return NextResponse.json({ action, assignment });
  }

  if (action === 'revoke') {
    const ok = await revokeRole({ userId: userId as string, roleName: roleName as string });
    if (!ok) {
      return NextResponse.json({ error: 'Role not found or not assigned' }, { status: 404 });
    }
    return NextResponse.json({ action, userId, roleName, revoked: true });
  }

  return NextResponse.json(
    { error: "action must be 'assign' or 'revoke'" },
    { status: 400 }
  );
}
