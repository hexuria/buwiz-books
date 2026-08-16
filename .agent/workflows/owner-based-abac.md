---
description: How to implement owner-based ABAC for resources (defense in depth)
---

# Owner-Based ABAC Pattern

This skill documents how to implement **owner-based permissions** where users can only modify resources they created, while admins can modify any resource.

## Overview

This pattern uses **defense in depth**:

1. **App-level checks** - Server functions verify ownership
2. **RLS-level checks** - PostgreSQL enforces ownership at database level

## Step 1: Add RLS Helper Functions

Ensure these helper functions exist in `drizzle/rls_policies.sql`:

```sql
// turbo
CREATE OR REPLACE FUNCTION current_user_id()
RETURNS TEXT
LANGUAGE SQL STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '');
$$;

CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT
LANGUAGE SQL STABLE AS $$
  SELECT NULLIF(current_setting('app.user_role', true), '');
$$;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE SQL STABLE AS $$
  SELECT current_user_role() IN ('owner', 'admin', 'superuser');
$$;
```

## Step 2: Add Owner-Based RLS Policies

For any table with an owner column (e.g., `uploaded_by_id`, `created_by_id`):

```sql
-- SELECT: all org members can view
CREATE POLICY {table}_select_policy ON {table} FOR SELECT
  USING (organization_id = current_organization_id());

-- INSERT: all org members can insert
CREATE POLICY {table}_insert_policy ON {table} FOR INSERT
  WITH CHECK (organization_id = current_organization_id());

-- UPDATE: owner or admin only
CREATE POLICY {table}_update_policy ON {table} FOR UPDATE
  USING (
    organization_id = current_organization_id()
    AND (is_admin() OR {owner_column} = current_user_id())
  )
  WITH CHECK (
    organization_id = current_organization_id()
    AND (is_admin() OR {owner_column} = current_user_id())
  );

-- DELETE: owner or admin only
CREATE POLICY {table}_delete_policy ON {table} FOR DELETE
  USING (
    organization_id = current_organization_id()
    AND (is_admin() OR {owner_column} = current_user_id())
  );
```

## Step 3: Add App-Level Helper

In your server functions file, add:

```typescript
/**
 * Check if user is the resource owner or has admin privileges.
 */
function isOwnerOrAdmin(
  resource: { ownerId: string | null }, // adjust field name
  userId: string,
  role: string,
): boolean {
  const isAdmin = role === "admin" || role === "superuser" || role === "owner";
  const isOwner = resource.ownerId === userId;
  return isAdmin || isOwner;
}
```

## Step 4: Use in Server Functions

```typescript
export const deleteResource = createServerFn({ method: "POST" }).handler(async ({ data }) => {
  await requirePermission(headers, "resource", "delete");

  const session = await requireSession(headers);
  const role = await getActiveMemberRole(headers);

  const [resource] = await db.select().from(resources).where(eq(resources.id, data.resourceId));

  if (!resource) throw new Error("Resource not found");

  // App-level ownership check (defense in depth)
  if (!isOwnerOrAdmin(resource, session.user.id, role || "member")) {
    throw new Error("You can only delete your own resources");
  }

  // RLS will also enforce this at database level
  await db.delete(resources).where(eq(resources.id, data.resourceId));
});
```

## Step 5: UI Permission Check

```tsx
import { usePermission } from "@/lib/use-permission";

function ResourceActions({ resource, currentUserId }) {
  const { canAccess: canDelete } = usePermission("resource", "delete");
  const isOwner = resource.ownerId === currentUserId;

  // Show delete only if user has permission AND (is owner OR is admin)
  const showDelete = canDelete && (isOwner || userRole === "admin");

  return showDelete && <DeleteButton />;
}
```

## Checklist

- [ ] Add RLS helper functions (`current_user_id`, `current_user_role`, `is_admin`)
- [ ] Replace `FOR ALL` policy with separate SELECT/INSERT/UPDATE/DELETE policies
- [ ] UPDATE and DELETE policies check `is_admin() OR owner_column = current_user_id()`
- [ ] Add `isOwnerOrAdmin()` helper in server functions
- [ ] Add ownership check before delete/update operations
- [ ] Add owner column index for query performance
- [ ] Run `bun db:rls` to apply RLS changes
