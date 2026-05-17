import { SetMetadata } from '@nestjs/common';

export var PERMISSIONS_KEY = 'requiredPermissions';

/**
 * @RequirePermission decorator
 *
 * Applied to controller methods to enforce access control.
 * The PermissionGuard reads this metadata and checks the
 * iam_effective_access_cache for the authenticated user.
 *
 * Usage:
 *   @RequirePermission('att-001:write')           // single permission
 *   @RequirePermission('att-001:read', 'att-001:write')  // any of these
 *
 * Permission codes follow the pattern: {function-code}:{tier}
 *   - att-001:read   → View Only
 *   - att-001:write  → Read/Write
 *   - att-001:admin  → Admin (Configure)
 *
 * The 148 function codes are defined in the Function Library.
 * The 3 tiers are: read, write, admin.
 */
export function RequirePermission(...permissions: string[]) {
  return SetMetadata(PERMISSIONS_KEY, permissions);
}
