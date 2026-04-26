import { config } from "dotenv";
config({ path: ["../../.env.local", "../../.env", ".env"] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';
import { createHash } from 'crypto';

/**
 * Builds the iam_effective_access_cache for all users with active assignments.
 * Run this after seeding to make permission checks work.
 */
async function buildCache() {
  console.log('');
  console.log('  Building effective access cache...');
  console.log('');

  var client = getPlatformClient();

  // Get all active assignments
  var assignments = await client.iamRoleAssignment.findMany({
    where: { status: 'ACTIVE' },
    include: {
      role: {
        include: {
          rolePermissions: {
            include: { permission: true },
          },
        },
      },
    },
  });

  // Group by account+scope
  var cacheMap: Record<string, {
    accountId: string;
    scopeId: string;
    permissions: Set<string>;
    assignmentIds: string[];
  }> = {};

  for (var i = 0; i < assignments.length; i++) {
    var assignment = assignments[i] as any;
    var key = assignment.accountId + '|' + assignment.scopeId;

    if (!cacheMap[key]) {
      cacheMap[key] = {
        accountId: assignment.accountId,
        scopeId: assignment.scopeId,
        permissions: new Set(),
        assignmentIds: [],
      };
    }

    var entry = cacheMap[key] as any;
    entry.assignmentIds.push(assignment.id);

    for (var j = 0; j < assignment.role.rolePermissions.length; j++) {
      var rp = assignment.role.rolePermissions[j] as any;
      entry.permissions.add(rp.permission.code);
    }
  }

  // Upsert cache entries
  var keys = Object.keys(cacheMap);
  for (var k = 0; k < keys.length; k++) {
    var cacheEntry = cacheMap[keys[k] as string] as any;
    var permCodes = Array.from(cacheEntry.permissions).sort() as string[];
    var versionHash = createHash('sha256')
      .update(cacheEntry.assignmentIds.sort().join(','))
      .digest('hex');

    // Check if exists
    var existing = await client.iamEffectiveAccessCache.findFirst({
      where: {
        accountId: cacheEntry.accountId,
        scopeId: cacheEntry.scopeId,
      },
    });

    if (existing) {
      await client.iamEffectiveAccessCache.update({
        where: { id: existing.id },
        data: {
          permissionCodes: permCodes,
          computedAt: new Date(),
          assignmentVersionHash: versionHash,
        },
      });
    } else {
      await client.iamEffectiveAccessCache.create({
        data: {
          id: generateId(),
          accountId: cacheEntry.accountId,
          scopeId: cacheEntry.scopeId,
          permissionCodes: permCodes,
          computedAt: new Date(),
          assignmentVersionHash: versionHash,
        },
      });
    }

    // Look up user email for display
    var user = await client.platformUser.findUnique({
      where: { id: cacheEntry.accountId },
      select: { email: true },
    });
    var email = user ? user.email : cacheEntry.accountId;
    console.log('  ' + email + ' -> ' + permCodes.length + ' permissions cached');
  }

  console.log('');
  console.log('  Cache built for ' + keys.length + ' account-scope pairs');
}

buildCache()
  .then(function() { return disconnectAll(); })
  .then(function() { process.exit(0); })
  .catch(function(e) {
    console.error('Cache build failed:', e);
    disconnectAll().then(function() { process.exit(1); });
  });
