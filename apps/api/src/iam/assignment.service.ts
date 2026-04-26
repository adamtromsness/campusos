import { Injectable } from '@nestjs/common';
import { PrismaClient, AssignmentSource } from '@prisma/client';
import { generateId } from '@campusos/database';
import { EffectiveAccessCacheService } from './effective-access-cache.service';

@Injectable()
export class AssignmentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cacheService: EffectiveAccessCacheService,
  ) {}

  /**
   * Grant a role to an account within a specific scope.
   */
  async grantRole(data: {
    accountId: string;
    roleId: string;
    scopeId: string;
    source: AssignmentSource;
    assignedBy?: string;
    effectiveTo?: Date;
    notes?: string;
  }) {
    var assignment = await this.prisma.iamRoleAssignment.create({
      data: {
        id: generateId(),
        accountId: data.accountId,
        roleId: data.roleId,
        scopeId: data.scopeId,
        source: data.source,
        assignedBy: data.assignedBy,
        effectiveTo: data.effectiveTo,
        notes: data.notes,
        status: 'ACTIVE',
      },
    });

    // Record history
    await this.prisma.iamRoleAssignmentHistory.create({
      data: {
        id: generateId(),
        assignmentId: assignment.id,
        changedBy: data.assignedBy,
        changeType: 'CREATED',
        newStatus: 'ACTIVE',
        changedAt: new Date(),
      },
    });

    // Record access change event
    await this.prisma.iamAccessChangeEvent.create({
      data: {
        id: generateId(),
        accountId: data.accountId,
        eventType: 'ROLE_GRANTED',
        actorId: data.assignedBy,
        scopeId: data.scopeId,
        roleId: data.roleId,
        assignmentId: assignment.id,
        eventAt: new Date(),
      },
    });

    // Rebuild effective access cache
    await this.cacheService.rebuildCache(data.accountId, data.scopeId);

    // TODO: Emit iam.role.assigned Kafka event

    return assignment;
  }

  /**
   * Revoke a role assignment.
   */
  async revokeAssignment(assignmentId: string, revokedBy?: string, reason?: string) {
    var assignment = await this.prisma.iamRoleAssignment.update({
      where: { id: assignmentId },
      data: { status: 'REVOKED' },
    });

    // Record history
    await this.prisma.iamRoleAssignmentHistory.create({
      data: {
        id: generateId(),
        assignmentId: assignmentId,
        changedBy: revokedBy,
        changeType: 'REVOKED',
        previousStatus: 'ACTIVE',
        newStatus: 'REVOKED',
        reason: reason,
        changedAt: new Date(),
      },
    });

    // Record access change event
    await this.prisma.iamAccessChangeEvent.create({
      data: {
        id: generateId(),
        accountId: assignment.accountId,
        eventType: 'ROLE_REVOKED',
        actorId: revokedBy,
        scopeId: assignment.scopeId,
        roleId: assignment.roleId,
        assignmentId: assignmentId,
        eventAt: new Date(),
      },
    });

    // Rebuild cache
    await this.cacheService.rebuildCache(assignment.accountId, assignment.scopeId);

    return assignment;
  }

  /**
   * Get all active assignments for an account.
   */
  async getAssignmentsForAccount(accountId: string) {
    return this.prisma.iamRoleAssignment.findMany({
      where: { accountId, status: 'ACTIVE' },
      include: {
        role: true,
        scope: true,
      },
    });
  }
}
