import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

@Injectable()
export class RoleService {
  constructor(private readonly prisma: PrismaClient) {}

  async findAll() {
    return this.prisma.role.findMany({
      include: {
        rolePermissions: {
          include: { permission: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async findById(id: string) {
    return this.prisma.role.findUnique({
      where: { id },
      include: {
        rolePermissions: {
          include: { permission: true },
        },
      },
    });
  }

  async findByName(name: string, schoolId?: string) {
    return this.prisma.role.findFirst({
      where: { name, schoolId: schoolId || null },
      include: {
        rolePermissions: {
          include: { permission: true },
        },
      },
    });
  }

  async create(data: { name: string; description?: string; schoolId?: string; isSystem?: boolean }) {
    return this.prisma.role.create({
      data: {
        id: generateId(),
        name: data.name,
        description: data.description,
        schoolId: data.schoolId,
        isSystem: data.isSystem || false,
      },
    });
  }

  async assignPermissions(roleId: string, permissionIds: string[]) {
    var createData = permissionIds.map(function(pid) {
      return {
        id: generateId(),
        roleId: roleId,
        permissionId: pid,
      };
    });

    return this.prisma.rolePermission.createMany({
      data: createData,
      skipDuplicates: true,
    });
  }

  async getPermissionByCode(code: string) {
    return this.prisma.permission.findUnique({ where: { code } });
  }

  async getAllPermissions() {
    return this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
  }
}
