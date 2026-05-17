import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

@Injectable()
export class ScopeService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Create a scope instance for an entity (school, department, class, etc.)
   */
  async createScope(data: {
    scopeTypeCode: string;
    entityId: string;
    entityTable: string;
    label: string;
    parentScopeId?: string;
  }) {
    var scopeType = await this.prisma.iamScopeType.findUnique({
      where: { code: data.scopeTypeCode },
    });

    if (!scopeType) {
      throw new Error('Unknown scope type: ' + data.scopeTypeCode);
    }

    return this.prisma.iamScope.create({
      data: {
        id: generateId(),
        scopeTypeId: scopeType.id,
        entityId: data.entityId,
        entityTable: data.entityTable,
        label: data.label,
        parentScopeId: data.parentScopeId,
      },
    });
  }

  /**
   * Find scope by entity.
   */
  async findByEntity(scopeTypeCode: string, entityId: string) {
    var scopeType = await this.prisma.iamScopeType.findUnique({
      where: { code: scopeTypeCode },
    });
    if (!scopeType) return null;

    return this.prisma.iamScope.findUnique({
      where: {
        scopeTypeId_entityId: {
          scopeTypeId: scopeType.id,
          entityId: entityId,
        },
      },
    });
  }

  /**
   * Get all child scopes of a parent.
   */
  async getChildren(parentScopeId: string) {
    return this.prisma.iamScope.findMany({
      where: { parentScopeId, isActive: true },
      include: { scopeType: true },
    });
  }
}
